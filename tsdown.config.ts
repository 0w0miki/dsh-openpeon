/**
 * Browser-half build: one CommonJS factory the web shell's module table loads
 * as `lib/client.js`. Every baseline module the shell already seeds stays
 * external and is reached through the injected `require`; CSS Modules are
 * compiled inline and injected as a `<style data-plugin-css>` tag, so the
 * artifact is self-contained apart from that baseline.
 */
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'

/** Package id the module table registers this bundle under. */
const PLUGIN_ID = 'dsh-openpeon'

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Baseline specifiers the shell seeds; requesting them privately would split module identity. */
const BASELINE_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

function sourceAssetPath(source: string, importer: string): string {
  return resolvePath(dirname(importer), source)
}

function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Record<string, string>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${fileId}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

export default defineConfig({
  entry: ['src/client/index.ts'],
  format: 'cjs',
  platform: 'browser',
  outDir: 'lib',
  dts: false,
  sourcemap: false,
  clean: true,
  deps: { neverBundle: BASELINE_EXTERNALS },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
  plugins: [{
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const source = readFileSync(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      const exportEntries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of exportEntries) classMap[local] = exp.name
      return styleInjectionModule(PLUGIN_ID, fileId, code.toString(), classMap)
    },
  }],
})
