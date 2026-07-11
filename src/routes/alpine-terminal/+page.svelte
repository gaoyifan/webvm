<script>
import WebVM from '$lib/WebVM.svelte';
import * as configObj from '/config_cloudflare_alpine_terminal';
</script>

<WebVM configObj={configObj} cacheId="blocks_alpine_terminal">
	<p>Looking for Debian? Try the <a class="underline" href="/" target="_blank">default terminal WebVM</a>, or the <a class="underline" href="/alpine.html" target="_blank">Alpine desktop</a> environment.</p>
</WebVM>
