import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = new URL('./', import.meta.url)
const path = name => fileURLToPath(new URL(name, root))
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
// The only generated directory; remove stale artifacts after typecheck succeeds.
const output = path('lib/')
if (output !== fileURLToPath(new URL('./lib/', import.meta.url))) throw new Error('Unexpected output path')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
// tsc preserves backend/, frontend/ and shared/ modules, including this Host entry:
// src/backend_index.ts -> lib/backend_index.js. No entrypoint scanning.
execFileSync(process.execPath, [path('node_modules/typescript/bin/tsc'), '-p', path('tsconfig.json')], { stdio: 'inherit' })
const svg = await readFile(new URL('icon.svg', root), 'utf8')
const client = await build({
  // Browser registration: src/frontend_index.ts -> lib/client.js (ModuleLoader).
  entryPoints: [path('src/frontend_index.ts')], bundle: true, write: false,
  platform: 'browser', format: 'cjs', target: 'es2022', charset: 'utf8', external: ['react'],
})
const code = client.outputFiles[0].text.replace('__PLUGIN_LOGS_ICON_DATA_URL__', `data:image/svg+xml,${encodeURIComponent(svg)}`)
await writeFile(new URL('lib/client.js', root), `window.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${code}\nreturn module.exports;}});\n`)
// Hand-authored RPC descriptors remain the compatibility source of truth.
await writeFile(new URL('lib/typert.host.mjs', root), "import { PACKAGE, descriptors } from './shared/contract.js'\nexport const TYPERT = { package: PACKAGE, face: 'host', schemas: [], invocations: descriptors, model: { services: [], events: [], objects: [] } }\n")
await writeFile(new URL('lib/typert.remote-client.mjs', root), "export { remote as default, remote as TYPERT_REMOTE } from './shared/contract.js'\n")
