/**
 * Build the dsh-health-panel client bundle (standard DSH client build template — css-module onLoad, jsx automatic).
 *
 * Produces lib/client.js in the exact wire format the DSH web shell expects:
 * a CJS factory handed to window.__ModuleLoader__.load({ id, factory }), with
 * platform modules resolved through the injected require (the loader module
 * table) and everything else inlined.
 *
 * esbuild is resolved from the DSH source checkout (the only place it is
 * installed); the plugin package itself has zero runtime dependencies.
 * Set DSH_SOURCE to the DSH checkout root when it is not the default
 * (~/.dsh/source/current).
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join, basename } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** DSH source checkout root; override with $DSH_SOURCE when not the default. */
const CHECKOUT = process.env.DSH_SOURCE ?? join(dirname(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))), '.')

/** Loader entry name — must equal the patch row `name` EXACTLY. */
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const PLUGIN_ID = MANIFEST.name

/** Platform module table (see packages/client/web/src/platform.ts). */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Locate the esbuild package inside a pnpm checkout (store or hoisted). */
function resolveEsbuild(checkout) {
  const store = join(checkout, 'node_modules/.pnpm')
  if (existsSync(store)) {
    const entries = readdirSync(store).filter((name) => name.startsWith('esbuild@')).sort()
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const candidate = join(store, entries[i], 'node_modules/esbuild/package.json')
      if (existsSync(candidate)) return candidate
    }
  }
  const hoisted = join(checkout, 'node_modules/esbuild/package.json')
  if (existsSync(hoisted)) return hoisted
  throw new Error(`esbuild not found under ${checkout} (set DSH_SOURCE to the DSH checkout root)`)
}

const require = createRequire(resolveEsbuild(CHECKOUT))
const esbuild = require('esbuild')

const banner = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')
const footer = 'return module.exports; } });'

/**
 * CSS Module loader for the plugin bundle.
 *
 * esbuild's built-in CSS handling would emit a separate .css file, which the
 * DSH shell does not load for plugin client bundles. This onLoad plugin
 * inlines the module instead, in the exact wire format the DSH plugin
 * ecosystem uses (see dsh-llm-fallbacks dist): hashed class names
 * (`_<8-hex>_<name>`, md5 of the class name), a `<style data-plugin-css>`
 * tag injected on first load, and a `{ name: hashedName }` default export.
 */
const cssModulePlugin = {
  name: 'css-module',
  setup(build) {
    build.onLoad({ filter: /\.module\.css$/ }, async (args) => {
      const css = await readFileSync(args.path, 'utf8')
      const names = [...css.matchAll(/\.([_a-zA-Z][\w-]*)(?=[\s,:{])/g)]
        .map((m) => m[1])
        .filter((n, i, all) => all.indexOf(n) === i)
      const map = {}
      let out = css
      // Longest first so `.cardOpen` is not clobbered by the `.card` rule.
      for (const name of [...names].sort((a, b) => b.length - a.length)) {
        const hashed = `_${createHash('md5').update(name).digest('hex').slice(0, 8)}_${name}`
        map[name] = hashed
        out = out.replaceAll(new RegExp(`\\.${name}(?![\\w-])`, 'g'), `.${hashed}`)
      }
      const tagId = `${PLUGIN_ID}/${basename(args.path)}`
      const contents = [
        `const css = ${JSON.stringify(out)};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
        '  const tag = document.createElement("style");',
        `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(map)};`,
      ].join('\n')
      return { contents, loader: 'js' }
    })
  },
}

await esbuild.build({
  entryPoints: [join(ROOT, 'src/client/index.ts')],
  outfile: join(ROOT, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // Automatic JSX runtime: the classic transform emits `React.createElement`
  // but our TSX only imports named hooks — no `React` binding — which made
  // the card crash at render ("React is not defined") and get abdicated by
  // the slot boundary. 'react/jsx-runtime' is already in EXTERNALS.
  jsx: 'automatic',
  plugins: [cssModulePlugin],
  external: EXTERNALS,
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
    'import.meta.env': '{"MODE":"production"}',
  },
  loader: { '.js': 'js' },
  banner: { js: banner },
  footer: { js: footer },
})

console.log('lib/client.js built')
