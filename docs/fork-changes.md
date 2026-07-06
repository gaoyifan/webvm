# WebVM Fork 技术文档：相对上游的改动

本文档描述本 fork（`cloudflare-workers-self-hosted` 分支）相对上游
[leaningtech/webvm](https://github.com/leaningtech/webvm) 主线的全部改动。

上游的 WebVM 依赖 Leaning Technologies 的官方基础设施：磁盘镜像由
`wss://disks.webvm.io` 的专有后端提供，CheerpX 运行时从
`cxrtnc.leaningtech.com` CDN 加载。本 fork 把整套东西搬到一个
Cloudflare Worker 上自托管：浏览器只访问
`https://webvm-disk-worker.<account>.workers.dev` 一个域名，磁盘协议、
前端、CheerpX 运行时全部由这个 Worker（免费套餐）提供，并在此基础上做了
一系列可靠性与启动性能优化。

- 维护分支：`cloudflare-workers-self-hosted`（唯一维护分支）
- 部署地址：`https://webvm-disk-worker.d58993771361bc4ff2f5.workers.dev`

## 1. 总体架构

```text
浏览器
 ├─ WebVM 前端（Workers Static Assets，本域名）
 ├─ CheerpX 运行时（镜像到 /cheerpx/<version>/，本域名）
 ├─ 启动块批量预取（bootblocks.json + bundles/bootbundle-<ts>.bin.gz，本域名）
 └─ CheerpX CloudDevice WebSocket（wss://<host>/<image>.ext2）
      │ 由 src/lib/disk-ws-reconnect.js 代理：断线重连 + 本地应答预取块
      ▼
 Edge Worker（workers/disk-worker/src/index.ts）
      │ 把 WebSocket upgrade 转发给 Durable Object；HTTP range 回退按请求处理
      ▼
 DiskSession Durable Object（每镜像 × 每 colo 一个实例）
      │ Hibernation API 终结客户端 WebSocket
      │ 64 MiB chunk LRU + 顺序预取
      ▼
 Workers Static Assets：/disks/<image>/chunks/000123.bin（1 MiB / 块）
```

设计约束来自 Workers 免费套餐：静态资产读取免费且带边缘缓存；每次
invocation 只有 50 个 subrequest 预算；无状态 Worker 持有的 WebSocket
没有生命周期保证。这三点决定了「资产存块 + DO 终结 WS」的形态。

## 2. 服务端：`workers/disk-worker/`（全部新增）

### 2.1 磁盘存储

`scripts/prepare-disk.mjs` 把 ext2 镜像切成 1 MiB 块文件上传为静态资产，
并生成 `manifest.json`（尺寸、块大小、mtime）。2 GB 的 Debian 镜像约
1908 个块。可以从本地镜像文件或直接从官方 `wss://disks.webvm.io`
增量下载生成。

### 2.2 Edge Worker

`src/index.ts` 的 fetch handler 只做三件事：把 `/<image>.ext2` 的
WebSocket upgrade 转发给按「镜像名@colo」命名的 DO；按请求处理 HTTP
range 回退（`?s=&e=` 或 `Range` 头，语义与官方服务器一致，200 + 精确
字节）；其余路径交给静态资产。

### 2.3 DiskSession Durable Object

- **WebSocket 终结与 Hibernation**：客户端 WebSocket 直接终结在 DO 上，
  用 Hibernation API（`acceptWebSocket` + `webSocketMessage`）。空闲时 DO
  可被驱逐而连接保持；每条消息唤醒时带全新的 subrequest 预算，所以长会
  话不会耗尽配额。这是平台唯一受支持的长连接模式。此前版本把 WS 终结在
  无状态 edge Worker 上，运行时会在数分钟后 load-shed 该 invocation
  （`wrangler tail` 可见 `loadShed`），CheerpX 无法从意外断开恢复，表现
  为「取几个块之后 server 停止响应」。这是本 fork 曾经的最严重 bug 及其
  修复。
- **DO 按 colo 分片**：DO 名为 `<image>@<colo>`，使实例落在（或接近）
  边缘 colo，减小 RTT；DO 不驻留的 colo（如 NRT 请求跑到 KIX）会付出一
  跳骨干网延迟。
- **chunk LRU 缓存**：64 MiB 内存缓存，避免重复读资产（冷资产读
  500–900 ms，热读是 RTT 级）。
- **启动 profile 录制**：启动读序列对固定镜像是确定的。DO 以 128 KiB 块
  粒度记录首次触达顺序（首个从块 0 开始读的会话触发记录，写入 DO
  storage），`export-boot-profile.mjs` 把录制结果导出为客户端批量预取用
  的静态资产（见 §3.2）。早期版本还让 DO 沿 profile 预热自己的 chunk
  缓存；bundle 上线后启动读几乎不再到达服务端，该 prewarm 已删除以简化
  实现。
- **顺序预取**：每次响应后向前预取 4 个 chunk。
- **错误处理**：资产读瞬时失败先进程内重试，再退化为 CloudDevice 协议
  的 1 字节重连信号；格式错误的请求关闭 socket；越过 EOF 截断，与官方
  服务器逐字节一致。
- **调试端点**：需要 `DEBUG_TOKEN` secret（`wrangler secret put`，以
  `Authorization: Bearer` 携带），未设置 secret 时整体关闭。
  `/debug/session`（缓存/profile 统计、重置/注入 profile）、
  `/debug/where`（edge colo vs DO colo 与 RPC 延迟）。

### 2.4 CloudDevice 协议实现

连接后服务端先发一条文本 `<size>-<mtimeEpoch>`；客户端逐条发文本
`<start>-<endInclusive>`，服务端回一条二进制精确字节；0 字节二进制为
keepalive，1 字节为「重连并重发」信号；空文本消息表示客户端关闭
（`beforeunload`）。协议行为通过 `scripts/test-disk-endpoint.mjs` 与官方
服务器做过逐字节对拍。

## 3. 客户端改动：`src/lib/`

### 3.1 `disk-ws-reconnect.js`（新增）

CheerpX 的磁盘客户端只认协议内的 1 字节重连信号，从不监听 socket 的
close/error，一次意外断开（部署、DO 迁移、网络抖动）就永久失去磁盘。
该模块用一个 WebSocket 代理包住磁盘连接：底层断开时透明重开、吞掉新
连接的元数据握手、重放在途的块请求，指数退避最多约 30 s，超限才向
CheerpX 暴露 close。同时它是启动预取的挂载点：每个 `<start>-<end>` 请求
先查预取存储，命中则本地合成二进制响应，未命中才发往服务端。

### 3.2 `disk-boot-prefetch.js`（新增）

启动时并行做三件事：取 `bootblocks.json`（157 个启动块列表 + 镜像元数
据）；打开 CheerpX 的 IndexedDB 块缓存（`cjFS_/<cacheId>/`），校验 meta
文件与当前镜像一致后枚举已有块；计算缺失集合。然后二选一：

- **基本全缺（冷启动）**：单请求下载 `bundles/bootbundle-<ts>.bin.gz`
  —— 157 个块按首次触达顺序拼接后 gzip，19.6 MiB → 5.7 MiB。用浏览器原
  生 `DecompressionStream("gzip")` 边下边解，每个块字节一到就可被 WS 代
  理本地应答（bundle 顺序即启动读取顺序，所以流式解压天然「先到先用」）。
  选择依据是字节数比较：`缺失块数 × 128 KiB > bundle 压缩后大小` 时用
  bundle。
- **大部分已缓存**：只对缺失块发少量合并的并行 HTTP range 请求（间隙
  ≤2 块合并、单请求 ≤8 MiB）。

全程 best-effort：bundle 404/截断/解压失败都会把剩余块转交 range 路径，
range 再失败则回落到原始 WebSocket 逐块读，只影响速度不影响正确性。
健壮性细节：等待批量数据的读请求按「下载停滞 15 s」而非总时长判定回退，
慢而未断的链路不会中途放弃；批量取完 2 分钟后释放未被读取的块，避免
profile 与实际读取的偏差长期占用内存；bundle 文件名带时间戳版本号并放
在 `bundles/` 目录（immutable 缓存头），「新列表配旧 bundle」的错配只会
404 然后走回退。

### 3.3 其他前端改动

- `WebVM.svelte`：在 `CheerpX.CloudDevice.create` 之前调用
  `installDiskSocketReconnect(cacheId)` 安装代理并启动预取。
- `config_cloudflare_terminal.js`（新增）：Cloudflare 部署的前端配置，
  磁盘 URL 默认 `wss://<当前域名>/<image>.ext2`，CheerpX 从本域名加载。
- `cheerpx-self-hosted.js`（新增）+ `vite.config.js`：`WEBVM_MODE=cloudflare`
  时把 `@leaningtech/cheerpx` 别名到本地 shim，从 `/cheerpx/<version>/`
  加载镜像好的运行时。
- `scripts/mirror-cheerpx.mjs`（新增）：下载并缓存 CheerpX 运行时全部文
  件（js/wasm 等）到 worker 资产目录。
- `scripts/build-cloudflare-worker.mjs`（新增）：一键构建——SvelteKit 构
  建、拷贝产物、镜像 CheerpX、准备磁盘块、生成 `_headers`（COOP/COEP，
  SharedArrayBuffer 必需；静态资产不经过 Worker，头必须走 `_headers`）。

## 3.5 网络：Tailscale 自动联网与出口节点

目标：打开页面即自动接入 tailnet 并能直接访问互联网，无需交互登录。

**服务端**（`src/index.ts` + `wrangler.jsonc`）：`/net/tailscale.json` 返回
`{authKey, exitNodeIp, derpPorts}`。`TS_AUTH_KEY` 是
Worker secret（Reusable + Ephemeral + tag:webvm 的 tskey），端点与页面同
样公开——每个访客都成为 tailnet 里一台临时打标节点，泄露面即页面本身，
轮换 key 即可吊销。其余两项是 vars。

**前端**（`network.js` / `WebVM.svelte` / `net-shim.js` 新增）：
`loadAuthKey()` 在 `Linux.create` 之前拉取配置（引擎在 create 时快照
`networkInterface`）；create 后 `autoConnect(cx)` 直接 `networkLogin()`，
无登录窗口。`net-shim.js` 包一层 `fetch`/`WebSocket` 修两个 wasm 网络
bug（见下），并把 `exitNodeIp` 发布到 `globalThis.__webvmTsExitNodeIp`。

**关键问题：exit node 的选择与应用。** 调查结论（对 wasm 二进制做字符串
分析 + Proxy 探针实测 + 官方 CLI 复现）：

- CheerpX 1.1.3 起（tailscale v1.78.3）`ipn.up()` 只读取
  `controlUrl/hostname/authKey/dnsIp/ipMap`，**`exitNodeIp` 被移除**，只
  剩引擎内部按 DERP 延迟自动 suggest。在本 tailnet 上（13 个广播
  0.0.0.0/0 的节点，仅 `do` 真正为 tag:webvm 转发——ACL `via` 限制），
  自动 suggest 稳定选中不转发的节点（`tailscale exit-node suggest` 同样
  选 oracle，实测不通），且 netmap 暴露给 JS 的 `exitNode` 标志恒为
  false，JS 侧无任何改选入口。官方 webvm.io（1.3.5）同样连不通，非本
  fork 特有。
- CheerpX 1.1.2 及更早（tailscale v1.76.3）的 `up()` **读取并应用**
  `exitNodeIp`（等价 `tailscale set --exit-node=<ip>`，控制面已验证该路
  径可用）。

**方案：钉住旧版 IPN 引擎。** `mirror-cheerpx.mjs` 把
`tun/tailscale.wasm` 单独钉在 1.1.2（其余运行时保持 1.3.0；两版
`wasm_exec.js` 字节相同，`ipn.run/tun/up` API 兼容）。28.6 MiB 超过
Workers 静态资产 25 MiB 单文件上限，故存 gzip（6.2 MiB）、浏览器用
`DecompressionStream` 解压后实例化——与 boot bundle 同一套做法。

**overrides 机制**（`workers/disk-worker/overrides/`，mirror 脚本在拷贝
缓存后覆盖）：

- `tailscale_tun.js`：改为加载 `tailscale.wasm.gz`；`newIPN` 改单参数调
  用（1.1.2 参数不同，两参会 `Usage` fatal 且 exit 1）；显式传入内存
  stateStorage（1.1.2 默认落 localStorage，CheerpX 的 worker 上下文里不
  存在，Go 侧直接退出——ephemeral key 每次启动重新注册，状态无需持久）。
- `tailscale_tun_auto.js`：netmap 到达后优先把
  `__webvmTsExitNodeIp`（在线校验后）写入 `settings.exitNodeIp` 再次
  `up()`，不依赖恒为 false 的 `p.exitNode` 标志。

**net-shim 修的两个 wasm URL bug**：DERP WebSocket URL 丢自定义端口
（`el2-chinanet.gaof.net:10000` 被拨成 443，从 `derpPorts` 补回）；
netcheck 探测把自定义端口错拼到官方 `*.tailscale.com` 中继上（剥掉非
443 端口）。

**结果**（无头 Chromium E2E，2026-07-06）：打开页面 → 自动登录 →
`curl https://ifconfig.me` 返回 `128.199.153.92`（do 的新加坡出口），
HTTPS 全程 ~3.9 s。页面全程只访问 worker 域名 + Tailscale 基础设施
（controlplane.tailscale.com、derp3e.tailscale.com），无其他第三方源。

## 4. 工具与测试

- `test-disk-endpoint.mjs`：协议级回归——WS/HTTP 各类边界（块边界跨越、
  EOF 截断、单字节、错误请求关闭语义），可对参考镜像逐字节校验，另含
  96 MiB 顺序 soak（验证吞吐与零重连）。当前部署 18 项全过。
- `export-boot-profile.mjs`：从 DO 调试端点导出录制的启动 profile，生成
  `bootblocks.json` 与 gzip bundle。
- `replay-boot.mjs` / `measure-boot.sh`：串行重放启动读序列测延迟分位；
  playwright 测浏览器 time-to-prompt。
- 端到端验证用 playwright-cli 无头 Chromium：冷/热启动计时、
  `md5sum /bin/bash` 与官方 webvm.io 输出一致（字节级完整性）。

## 5. 性能数据

测量环境：无头 Chromium，出口位于日本（边缘 colo NRT，DO 落在 KIX），
2026-07-06。「冷」= 全新浏览器 profile（无 IndexedDB）。

| 方案 | 到提示符 | 磁盘请求数 | 磁盘传输量 |
| --- | --- | --- | --- |
| 官方 webvm.io（对照） | ~14 s | ~157 次串行 WS | ~19.6 MiB |
| fork：纯 WS 逐块（初版） | ~19 s | ~157 次串行 WS | ~19.6 MiB |
| fork：range 并行预取 | ~6 s | 31 次 HTTP | 20.8 MiB |
| fork：gzip bundle（当前） | **3.7–4.3 s** | **2 次 HTTP** | **5.7 MiB** |
| fork：热启动（IDB 已有） | ~5.6 s | 3 次 HTTP | ~0.25 MiB |

- 冷启动 3.7–4.3 s 出提示符（两次独立测量），再 ~0.5 s 完成
  `md5sum /bin/bash`；bundle 下载 1.0–1.3 s，与 WASM 编译完全重叠。
- 热启动不取 bundle，只对 profile 内本次未缓存的 2 个块发 range 请求
  （预取器按字节数自动选路径的直接体现）。
- 交互延迟：warm 串行 128 KiB 读 p50 ≈ 120 ms（NRT→KIX 一跳）vs 官方
  73 ms；冷散读 ~550 ms vs 官方 ~1100 ms。首次 `apt` 这类冷命令我们
  ~11.7 s vs 官方 ~9 s，差距即 DO 跳数；DO 驻留的 colo 无此差距。

## 6. 压缩与 btrfs + zstd 的评估

**现状**：磁盘块以原始字节存储；传输层面，WS 连接协商了
permessage-deflate（Workers 兼容日期 ≥2023-08-15 自动启用，实测握手返回
`permessage-deflate; client_max_window_bits=15`），HTTP range 路径是
`application/octet-stream`、Cloudflare 不压缩（实测 transferSize ≈
decodedBodySize + 头部）。gzip boot bundle 把冷启动这个大头显式压缩：
19.6 MiB → 5.7 MiB（-71%），且单请求 + 流式解压，一并消掉了逐块 RTT。

**btrfs + zstd 不可行**：磁盘格式由 CheerpX 决定，而 CheerpX（闭源）只
实现了 ext2——挂载类型仅有 `ext2`，官方文档与 1.0 发布说明明确路线是
ext2 向 ext3/ext4 兼容演进，没有 btrfs 支持。换成 btrfs+zstd 镜像后引擎
根本无法解析文件系统，此路不通。

**zstd 作为传输压缩的取舍**：实测启动 bundle gzip-9 5.5–5.7 MiB、
zstd-19 4.3 MiB、brotli-9 4.7 MiB。选 gzip 的原因：浏览器原生
`DecompressionStream` 只支持 gzip/deflate（2026-07 时点所有浏览器都不支
持 zstd，见 whatwg/compression#54），zstd/brotli 需要引入 wasm 解码器，
为省 ~1.4 MiB 引入额外依赖与主线程解码成本不划算。两条可等待的升级路
径：`DecompressionStream("zstd")` 标准化后直接换字典；或让 bundle 走
Worker 动态路由、按 `Accept-Encoding` 协商返回 `Content-Encoding: zstd`
（Chrome 123+ / Firefox 126+ / Safari 26.3+ 已支持 zstd 内容编码，需
`encodeBody: "manual"` 直通）。

**启动之外的读**：非启动路径的按需读走 WS，已有 permessage-deflate 帧
压缩兜底；瓶颈是逐块串行的 RTT 而非字节数，进一步压缩收益有限。range
预取路径（部分缓存场景）目前未压缩，若要优化可让这些请求改走 Worker
动态路由做内容编码，当前数据量小（约几百 KiB）未做。

## 7. 镜像换代：Debian 11/12/13 评估与切换到 bullseye

上游镜像是 Debian 10（buster），已 EOL——`deb.debian.org` 已下架其索引，
VM 内 `apt update` 直接 404，装不了任何新包。`scripts/build-debian-image.sh`
用 debootstrap（无需 Docker）构建 i386 ext2 镜像（bullseye/bookworm/trixie
任选），包集合对齐上游 `dockerfiles/debian_large`。构建要点：

- `mke2fs -E revision=0 -d <rootfs>` 用户态填充：内核挂载拷贝会因新版
  Debian 自带的文件 capabilities（如 ping）写入 xattr，把文件系统悄悄
  升级到 revision 1 + ext_attr，CheerpX 的 ext2 驱动直接拒载；
- 镜像内 `/dev` 清空成与上游一致的形态（仅 `pts`/`shm` 空目录 +
  空 `console` 文件）：镜像里真实的字符设备节点会遮蔽 CheerpX 的虚拟
  `/dev`，打开即永久阻塞（`su`/`sudo` 在 `/dev/tty` 上挂死的原因之一）；
- 排除 exim4/bsd-mailx（MTA 死重 + postinst 在 chroot 里失败）；
- buster 之后的原生 `su`/`sudo` 在 CheerpX 下都挂死（libxcrypt crypt()
  初始化不返回），镜像自带 `/usr/local/bin/sudo` setuid wrapper（PATH
  优先遮蔽原生 sudo，直接 setuid+exec，等价单用户 VM 的 NOPASSWD sudo）。

**结论：13/12 均被 CheerpX 1.3.0 的 i386 仿真 bug 挡住，11（bullseye）
全部功能可用，已切为默认镜像**（`debian_bullseye_20260706_1.ext2`）。
三个候选镜像的块与 boot bundle 均已上传，设 `WEBVM_DISK_IMAGE` 重建即可
互相切换。

同环境实测对比（2026-07-06，冷启动均为清空 IDB + HTTP 缓存后带 bundle）：

| | buster（原默认） | bullseye（新默认） | bookworm | trixie |
| --- | --- | --- | --- | --- |
| Debian / 支持期 | 10，EOL 2024 | 11，LTS 至 2026-08 | 12，LTS 至 2028-06 | 13，安全支持至 2028 |
| 镜像大小 | 2.0 GB / 1908 块 | 2.4 GB / 2289 块 | 同左 | 同左 |
| boot bundle | 5.7 MiB / 157 块 | 4.2 MiB / 112 块 | —（未录制） | 5.3 MiB / 152 块 |
| 冷启动到提示符 | 3.7–4.4 s | 3.6–4.0 s | —（~28 s 无 bundle） | 3.9 s |
| `apt update` | ✗（EOL，404） | ✓ | ✗ **挂死** | ✓ |
| `apt install` | ✗ | ✓（装 sl 实测） | ✗ | ✓（7.8 s 冷 `apt`） |
| python3 | 3.7（✓） | 3.9（✓，含 os.urandom） | 3.11：**退出时故障** | 3.13：**启动即挂** |
| gcc / node | 8.3 / 10.24（✓） | 10.2 / 12.22（✓） | 12.2 / 18.20（✓） | 14.2 / 20.19（✓） |
| sudo | ✓ | wrapper ✓（原生挂） | wrapper ✓（原生挂） | wrapper ✓（原生挂） |

bullseye 的取舍：所有功能今天都可用，但 LTS 到 2026-08-31 结束（i386 在
支持架构内），之后 `deb.debian.org` 会像 buster 一样下架索引，apt 再次
失效（届时可把 sources.list 指到 archive.debian.org 继续装旧包）。
bookworm 的 LTS 到 2028 年中且支持 i386，是理想目标，但见下文仿真 bug。

CheerpX 兼容性问题（版本越新触雷越多，buster/bullseye 不触）：

- **python3.13 致命（trixie）**：任何实际执行（`python3 -c 'print(1)'`
  即可复现）陷入不可中断的死循环并拖死整个 VM。浏览器控制台可见故障日志
  `Fault addr 0x13d4a, ip 0x8170491, proc /usr/bin/python3`——libpython
  内部（`PyDict_Contains` 之后的内部函数）拿着近空指针访存，属指令级
  仿真错误，1.3.0 与 1.3.5 均复现。`python3 --version`（早退路径）正常。
- **python3.11 退出故障（bookworm）**：脚本能执行并输出（os.urandom 也
  正常），但解释器退出阶段触发同类故障
  （`Fault addr 0x23dc0, ip 0x8295fb6, proc /usr/bin/python3`），进程
  不返回、shell 拿不到退出码，VM 随之卡死——实际不可用。
- **apt update 挂死（bookworm）**：网络本身通（curl 正常），http worker
  子进程启动后（`Starting method '/usr/lib/apt/methods/http'` 已打印）
  无任何进展，强制 IPv4 无效。bullseye/trixie 的 apt 同路径正常。
- **libxcrypt 挂死（bullseye/bookworm/trixie）**：crypt() 初始化在仿真下
  不返回，PAM 因此拖死 `su`/`sudo`/`passwd`；用镜像内 setuid wrapper
  绕过（见上）。
- **getrandom() 挂死（1.3.0 × trixie glibc 2.41）**：trixie 的 glibc
  getrandom 路径在 1.3.0 下不返回（python `os.urandom`、libxcrypt 熵
  初始化挂死）；buster（2.28）/bullseye（2.31）在同一运行时上正常
  （实测即时返回真实字节）。1.3.5 对 trixie 也已修复（实测 n=16）。
- **CheerpX 1.3.5 不可用**：曾试升级到 1.3.5 换 getrandom 修复，但其
  futex 处理让 dpkg-deb 的子进程全部报
  `The futex facility returned an unexpected error code`，`apt install`
  在任何镜像上都会失败；且 python3.13 依旧挂。故运行时保持 1.3.0
  （见 `scripts/mirror-cheerpx.mjs` 的版本注释）。

升级到 bookworm/trixie 的前提是 CheerpX 修复上述仿真 bug（闭源，无法
自行修）；届时用构建脚本重建即可。

## 8. 已知限制与未来工作

- DO 不驻留的 colo 有一跳骨干网延迟（`apt` 慢 ~2.7 s）；无法在免费套餐
  内消除，可观察 Cloudflare 扩 DO colo 覆盖。
- 磁盘只读共享 + IndexedDB 本地写层，与上游一致；未做多镜像管理 UI。
- 客户端预取依赖 CheerpX 私有的 IndexedDB 布局（`cjFS_/<id>/`）判断已缓
  存块；CheerpX 升级若改布局，仅退化为「当作全冷、多下一次 bundle」，不
  影响正确性。
- 未来：bundle 的 zstd 内容编码协商；镜像更新后自动重录/导出 profile。
- Tailscale IPN 引擎钉在 CheerpX 1.1.2 的 wasm（v1.76.3）：这是最后一个
  支持 JS 侧指定 `exitNodeIp` 的构建。升级前需确认新版恢复该能力，或改
  为自编译 tailscale wasm（tsconnect 目标是开源的，但 CheerpX 的
  tailscale_tun 桥接层是私有 fork，需要复刻）。Tailscale 控制面对
  v1.76（2024-11）的最低版本支持到期前需处理。

## 9. 变更文件清单

新增：

- `workers/disk-worker/`：`src/index.ts`（edge + DO 全部服务端逻辑）、
  `wrangler.jsonc`、`scripts/{prepare-disk,export-boot-profile,replay-boot,test-disk-endpoint}.mjs`、
  `scripts/measure-boot.sh`、`README.md`
- `workers/disk-worker/overrides/cheerpx/1.3.0/tun/`：
  `tailscale_tun.js`、`tailscale_tun_auto.js`（镜像时覆盖上游的 fork 补丁）
- `src/lib/disk-ws-reconnect.js`、`src/lib/disk-boot-prefetch.js`、
  `src/lib/cheerpx-self-hosted.js`、`src/lib/net-shim.js`
- `scripts/build-cloudflare-worker.mjs`、`scripts/mirror-cheerpx.mjs`
- `scripts/build-debian-image.sh`（bullseye/bookworm/trixie 镜像构建，见 §7）
- `config_cloudflare_terminal.js`
- `docs/fork-changes.md`（本文档）

修改：

- `src/lib/WebVM.svelte`（安装磁盘 socket 代理；Tailscale 自动联网）
- `src/lib/network.js`（`loadAuthKey`/`autoConnect`）
- `vite.config.js`（cloudflare 模式下的 CheerpX 别名）
- `package.json`（`build:cloudflare-worker` 脚本）
- `README.md`（Cloudflare 部署章节）
- `.gitignore`（资产、镜像缓存等）

## 10. 运维速查

```sh
# 全量构建（前端 + CheerpX 镜像 + 磁盘块）并部署
npm run build:cloudflare-worker
cd workers/disk-worker && npx wrangler deploy

# 设置调试 token（一次性；profile 导出依赖 /debug/ 端点）
cd workers/disk-worker && npx wrangler secret put DEBUG_TOKEN

# 更新启动 profile 与 bundle（先真实启动一次让 DO 录制）
DEBUG_TOKEN=... node scripts/export-boot-profile.mjs --host <worker-host> --image <image>.ext2
npx wrangler deploy

# 协议回归
node scripts/test-disk-endpoint.mjs --url wss://<worker-host>/<image>.ext2 --quick

# Tailscale 自动联网（一次性）：设置 tskey（Reusable+Ephemeral+tag:webvm）
cd workers/disk-worker && npx wrangler secret put TS_AUTH_KEY
# 出口节点固定在 wrangler.jsonc vars：TS_EXIT_NODE_IP（须为 ACL 允许
# tag:webvm 使用、且真实转发的 exit node）
```
