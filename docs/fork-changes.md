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
 ├─ 启动块批量预取（bootblocks.json + bootbundle-<ts>.bin.gz，本域名）
 └─ CheerpX CloudDevice WebSocket（wss://<host>/<image>.ext2）
      │ 由 src/lib/disk-ws-reconnect.js 代理：断线重连 + 本地应答预取块
      ▼
 Edge Worker（workers/disk-worker/src/index.ts）
      │ 把 WebSocket upgrade 转发给 Durable Object；HTTP range 回退按请求处理
      ▼
 DiskSession Durable Object（每镜像 × 每 colo 一个实例）
      │ Hibernation API 终结客户端 WebSocket
      │ 64 MiB chunk LRU + 启动 profile 预热 + 顺序预取
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
- **启动 profile**：启动读序列对固定镜像是确定的。DO 以 128 KiB 块粒度
  记录首次触达顺序（首个从块 0 开始读的会话触发记录，写入 DO storage，
  也可从 `bootblocks.json` 资产直接加载）。用途有二：客户端批量预取
  （见 §3.2）；DO 端沿 profile 派生的 chunk 顺序预热缓存，保持领先客户
  端 ≤32 chunk，使真正到达服务端的启动读保持 RTT 级。
- **顺序预取**：每次响应后向前预取 4 个 chunk。
- **错误处理**：资产读瞬时失败先进程内重试，再退化为 CloudDevice 协议
  的 1 字节重连信号；格式错误的请求关闭 socket；越过 EOF 截断，与官方
  服务器逐字节一致。
- **调试端点**（`DEBUG_ENDPOINTS=1` 时）：`/debug/session`（缓存/profile
  统计、重置/注入 profile）、`/debug/where`（edge colo vs DO colo 与 RPC
  延迟）。

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

- **基本全缺（冷启动）**：单请求下载 `bootbundle-<ts>.bin.gz` —— 157 个
  块按首次触达顺序拼接后 gzip，19.6 MiB → 5.7 MiB。用浏览器原生
  `DecompressionStream("gzip")` 边下边解，每个块字节一到就可被 WS 代理
  本地应答（bundle 顺序即启动读取顺序，所以流式解压天然「先到先用」）。
  选择依据是字节数比较：`缺失块数 × 128 KiB > bundle 压缩后大小` 时用
  bundle。
- **大部分已缓存**：只对缺失块发少量合并的并行 HTTP range 请求（间隙
  ≤2 块合并、单请求 ≤8 MiB）。

全程 best-effort：bundle 404/截断/解压失败都会把剩余块转交 range 路径，
range 再失败则回落到原始 WebSocket 逐块读，只影响速度不影响正确性。
bundle 文件名带时间戳版本号，杜绝「新列表配旧 bundle」的错配（错配只会
404 然后走回退）。

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
| fork：gzip bundle（当前） | **~4.3 s** | **2 次 HTTP** | **5.7 MiB** |
| fork：热启动（IDB 已有） | ~5.6 s | 3 次 HTTP | ~0.25 MiB |

- 冷启动 4.25 s 出提示符，4.77 s 完成 `md5sum /bin/bash`；bundle 下载
  1.3 s，与 WASM 编译完全重叠。
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

## 7. 已知限制与未来工作

- DO 不驻留的 colo 有一跳骨干网延迟（`apt` 慢 ~2.7 s）；无法在免费套餐
  内消除，可观察 Cloudflare 扩 DO colo 覆盖。
- 磁盘只读共享 + IndexedDB 本地写层，与上游一致；未做多镜像管理 UI。
- `DEBUG_ENDPOINTS=1` 当前开启（profile 导出依赖它），生产可置 0。
- 未来：bundle 的 zstd 内容编码协商；`bootblocks.json` 随镜像版本自动
  失效清理。

## 8. 变更文件清单

新增：

- `workers/disk-worker/`：`src/index.ts`（edge + DO 全部服务端逻辑）、
  `wrangler.jsonc`、`scripts/{prepare-disk,export-boot-profile,replay-boot,test-disk-endpoint}.mjs`、
  `scripts/measure-boot.sh`、`README.md`
- `src/lib/disk-ws-reconnect.js`、`src/lib/disk-boot-prefetch.js`、
  `src/lib/cheerpx-self-hosted.js`
- `scripts/build-cloudflare-worker.mjs`、`scripts/mirror-cheerpx.mjs`
- `config_cloudflare_terminal.js`
- `docs/fork-changes.md`（本文档）

修改：

- `src/lib/WebVM.svelte`（安装磁盘 socket 代理）
- `vite.config.js`（cloudflare 模式下的 CheerpX 别名）
- `package.json`（`build:cloudflare-worker` 脚本）
- `README.md`（Cloudflare 部署章节）
- `.gitignore`（资产、镜像缓存等）

## 9. 运维速查

```sh
# 全量构建（前端 + CheerpX 镜像 + 磁盘块）并部署
npm run build:cloudflare-worker
cd workers/disk-worker && npx wrangler deploy

# 更新启动 profile 与 bundle（先真实启动一次让 DO 录制）
node scripts/export-boot-profile.mjs --host <worker-host> --image <image>.ext2
npx wrangler deploy

# 协议回归
node scripts/test-disk-endpoint.mjs --url wss://<worker-host>/<image>.ext2 --quick
```
