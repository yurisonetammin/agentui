import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

function rendererCspPlugin(): Plugin {
  return {
    name: 'agentui-renderer-csp',
    transformIndexHtml(html, ctx) {
      // 独立浏览器窗口页需要加载远程 favicon，img-src 额外放行 http(s)。
      const isBrowserPage = html.includes('<!-- AGENTUI_BROWSER_CSP -->')
      const csp = ctx.server
        ? "default-src 'self' http://localhost:* ws://localhost:*; script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; connect-src 'self' http://localhost:* ws://localhost:*;"
        : isBrowserPage
          ? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:;"
          : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
      return html
        .replace('<!-- AGENTUI_BROWSER_CSP -->', '')
        .replace(
          '<!-- AGENTUI_CSP -->',
          `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
        )
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('electron/preload/index.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    plugins: [react(), rendererCspPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          browser: resolve('src/renderer/browser.html'),
        },
      },
    },
  },
})
