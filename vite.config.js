import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const terminalConfig = process.env.WEBVM_MODE == "github" ? 'config_github_terminal.js' :
	process.env.WEBVM_MODE == "cloudflare" ? 'config_cloudflare_terminal.js' :
	'config_public_terminal.js';

// The cloudflare build is fully self-hosted: the CheerpX runtime is loaded
// from this origin (mirrored into the Worker assets by
// scripts/mirror-cheerpx.mjs) instead of cxrtnc.leaningtech.com.
const cheerpxModule = process.env.CX_URL ? process.env.CX_URL :
	process.env.WEBVM_MODE == "cloudflare" ? new URL('./src/lib/cheerpx-self-hosted.js', import.meta.url).pathname :
	"@leaningtech/cheerpx";

export default defineConfig({
	resolve: {
		alias: {
			'/config_terminal': terminalConfig,
			"@leaningtech/cheerpx": cheerpxModule
		}
	},
	build: {
		target: "es2022"
	},
	plugins: [
		sveltekit(),
		viteStaticCopy({
			targets: [
				{ src: 'tower.ico', dest: '' },
				{ src: 'scrollbar.css', dest: '' },
				{ src: 'serviceWorker.js', dest: '' },
				{ src: 'login.html', dest: '' },
				{ src: 'assets/', dest: '' },
				{ src: 'documents/', dest: '' }
			]
		})
	]
});
