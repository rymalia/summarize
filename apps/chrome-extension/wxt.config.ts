import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'wxt'

const extensionVersion = (() => {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const gitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'unknown'
  }
})()

export default defineConfig({
  srcDir: 'src',
  vite: () => ({
    define: {
      __SUMMARIZE_VERSION__: JSON.stringify(extensionVersion),
      __SUMMARIZE_GIT_HASH__: JSON.stringify(gitHash),
    },
    resolve: {
      alias: {
        react: 'preact/compat',
        'react-dom': 'preact/compat',
        'react/jsx-runtime': 'preact/jsx-runtime',
        'react/jsx-dev-runtime': 'preact/jsx-dev-runtime',
      },
    },
  }),
  manifest: {
    name: 'Summarize',
    description: 'Summarize what you see. Articles, threads, YouTube, podcasts — anything.',
    homepage_url: 'https://summarize.sh',
    version: extensionVersion,
    icons: {
      16: 'assets/icon-16.png',
      32: 'assets/icon-32.png',
      48: 'assets/icon-48.png',
      128: 'assets/icon-128.png',
    },
    permissions: [
      'tabs',
      'activeTab',
      'storage',
      'sidePanel',
      'webNavigation',
      'scripting',
      'windows',
    ],
    host_permissions: ['<all_urls>', 'http://127.0.0.1:8787/*'],
    background: {
      type: 'module',
      service_worker: 'background.js',
    },
    action: {
      default_title: 'Summarize',
      default_icon: {
        16: 'assets/icon-16.png',
        32: 'assets/icon-32.png',
        48: 'assets/icon-48.png',
        128: 'assets/icon-128.png',
      },
    },
    side_panel: {
      default_path: 'sidepanel/index.html',
    },
    options_ui: {
      page: 'options/index.html',
      open_in_tab: true,
    },
  },
})
