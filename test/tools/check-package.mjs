import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
import { exportValidatedPackage, parsePackageOutput } from './release.mjs'

// Invoked from any cwd; dependencies resolve only from this plugin installation.
const root = fileURLToPath(new URL('../../', import.meta.url))
const outputDirectory = parsePackageOutput(process.argv.slice(2))
const destination = await mkdtemp(join(tmpdir(), 'plugin-logs-package-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', destination], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))[0]
const paths = result.files.map(file => file.path).sort()
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
assert.equal(result.name, manifest.name)
assert.equal(result.version, manifest.version)
const documentation = new Set(['README.md', 'README.en.md', 'RELEASING.md', 'LICENSE'])
const screenshots = JSON.parse(await readFile(join(root, 'screenshots.json'), 'utf8'))
assert.ok(Array.isArray(screenshots) && screenshots.length > 0)
for (const path of screenshots) assert.match(path, /^docs\/[^/]+\.png$/)
for (const path of paths) assert.ok(path === 'package.json' || documentation.has(path) || path === 'icon.svg' || path === 'screenshots.json' || screenshots.includes(path) || /^lib\/.+\.(?:js|mjs)$/.test(path) || path === 'bundles/plugin-logs.patch.yml', `Unexpected published file: ${path}`)
for (const path of documentation) assert.ok(paths.includes(path), `Missing user documentation: ${path}`)
for (const path of ['screenshots.json', ...screenshots]) assert.ok(paths.includes(path), `Missing screenshot asset: ${path}`)
for (const path of [...Object.values(manifest.exports), manifest.dsh.bundle.patch, manifest.icon]) assert.ok(paths.includes(path.replace(/^\.\//, '')), `Missing package target: ${path}`)
async function outputs(directory = 'lib') {
  const result = []
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory + '/' + entry.name
    if (entry.isDirectory()) result.push(...await outputs(path))
    else result.push(path)
  }
  return result
}
for (const path of await outputs()) assert.ok(paths.includes(path), `Missing build output: ${path}`)
const archive = join(destination, result.filename)
const archivedPaths = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/).map(path => path.replace(/^package\//, '')).sort()
assert.deepEqual(archivedPaths, paths, 'Actual archive must match npm file manifest')
execFileSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit' })
const extracted = join(destination, 'package')
assert.deepEqual(JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8')), manifest)
const packedFiles = new Set(paths)
for (const path of paths.filter(path => /\.(?:js|mjs)$/.test(path))) {
  const text = await readFile(join(extracted, path), 'utf8')
  const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  for (const node of parsed.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue
    const specifier = node.moduleSpecifier
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue
    const target = new URL(specifier.text, pathToFileURL(join(extracted, path)))
    const resolved = relative(extracted, fileURLToPath(target)).replaceAll('\\', '/')
    assert.ok(packedFiles.has(resolved), `Missing relative dependency: ${path} -> ${specifier.text}`)
  }
}
// The package's runtime dependencies are peers. Explicitly provide the installation
// under test, never a global Host fallback, for unpacked runtime smoke checks.
await symlink(join(root, 'node_modules'), join(extracted, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
const host = await import(pathToFileURL(join(extracted, manifest.exports['.'])).href)
const { Context } = await import('@deepseek-ai/cordis')
assert.equal(host.name, 'plugin-logs')
const ctx = new Context()
ctx.reflect.provide('agents', { get: () => undefined })
ctx.reflect.provide('tools', {})
const fiber = ctx.plugin(host, { capacity: 3 })
try {
  await fiber.await()
  ctx.logger('package-test').info('packed host works')
  assert.equal(ctx.get('pluginLogs').tail(0, 10).entries.at(-1).text, 'packed host works')
} finally { await fiber.dispose() }
const { TYPERT } = await import(pathToFileURL(join(extracted, manifest.exports['./typert'])).href)
const { default: remote } = await import(pathToFileURL(join(extracted, manifest.exports['./remote'])).href)
assert.equal(TYPERT.package, manifest.name)
assert.equal(remote.package, manifest.name)
assert.equal(TYPERT.invocations.length, 3)
let registration
vm.runInNewContext(await readFile(join(extracted, manifest.exports['./client']), 'utf8'), { window: { __ModuleLoader__: { load(value) { registration = value } } } })
assert.equal(registration.id, manifest.name)
const browser = registration.factory(name => { assert.equal(name, 'react'); return {} })
assert.equal(browser.name, 'plugin-logs/client')
assert.equal(typeof browser.apply, 'function')
console.log(`Verified ${paths.length} packed files, all relative imports, Host, RPC and lazy browser entry: ${join(destination, result.filename)}`)
if (outputDirectory) console.log(`Exported validated archive: ${await exportValidatedPackage(archive, outputDirectory)}`)
