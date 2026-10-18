import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { Context } from '@deepseek-ai/cordis'

const root = new URL('../', import.meta.url)
const read = name => readFile(new URL(name, root), 'utf8')
async function sources(directory = 'src/') {
  const files = []
  for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
    const name = directory + entry.name
    if (entry.isDirectory()) files.push(...await sources(name + '/'))
    else if (/\.tsx?$/.test(name)) files.push(name)
  }
  return files
}

test('source layering has explicit entries and shared modules never depend on either end', async () => {
  const files = await sources()
  assert.deepEqual(files.filter(name => !name.slice(4).includes('/')).sort(), ['src/backend_index.ts', 'src/frontend_index.ts'])
  for (const file of files) {
    const text = await read(file)
    const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    for (const node of parsed.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue
      const specifier = node.moduleSpecifier
      if (!specifier || !ts.isStringLiteral(specifier)) continue
      if (file.startsWith('src/shared/')) {
        assert.ok(specifier.text.startsWith('./') || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly), `${file} must stay shared-only: ${specifier.text}`)
      } else if (specifier.text.startsWith('.')) {
        const resolved = fileURLToPath(new URL(specifier.text, new URL(file, root)))
        const forbidden = file.startsWith('src/frontend/') ? 'backend/' : file.startsWith('src/backend/') ? 'frontend/' : null
        if (forbidden) assert.ok(!resolved.startsWith(fileURLToPath(new URL('src/' + forbidden, root))), `${file} crosses runtime boundaries`)
      }
    }
    // No compiler escape hatches in maintained business sources.
    assert.doesNotMatch(text, /@ts-(?:ignore|nocheck|expect-error)/)
    function visit(node) {
      assert.notEqual(node.kind, ts.SyntaxKind.AnyKeyword, `${file}: explicit any`)
      if (ts.isAsExpression(node)) assert.ok(!(ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword), `${file}: double assertion`)
      ts.forEachChild(node, visit)
    }
    visit(parsed)
  }
  const config = JSON.parse(await read('tsconfig.json'))
  assert.equal(config.compilerOptions.strict, true)
  assert.notEqual(config.compilerOptions.noImplicitAny, false)
  assert.notEqual(config.compilerOptions.strictNullChecks, false)
})

test('manifest entries, bundle identity and emitted modules agree with the source layout', async () => {
  const manifest = JSON.parse(await read('package.json'))
  assert.equal(manifest.exports['.'], './lib/backend_index.js')
  assert.equal(manifest.exports['./client'], './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './bundles/plugin-logs.patch.yml')
  assert.equal(manifest.name, '@lemonel/dsh-plugin-logs')
  const lock = JSON.parse(await read('package-lock.json'))
  assert.equal(lock.name, manifest.name)
  assert.equal(lock.packages[''].name, manifest.name)
  assert.equal(lock.version, manifest.version)
  assert.equal(lock.packages[''].version, manifest.version)
  assert.match(await read(manifest.dsh.bundle.patch), /id: lemonel-plugin-logs/)
  assert.match(await read(manifest.dsh.bundle.patch), /@lemonel\/dsh-plugin-logs/)
  for (const target of Object.values(manifest.exports)) await access(new URL(target, root))
  for (const file of await sources()) await access(new URL(file.replace(/^src\//, 'lib/').replace(/\.tsx?$/, '.js'), root))
  for (const stale of ['index', 'host', 'core', 'query', 'contract', 'types', 'client-runtime', 'tool-state', 'client-compat']) {
    await assert.rejects(access(new URL(`lib/${stale}.js`, root)))
  }
  const build = await read('build.mjs')
  assert.match(build, /src\/frontend_index\.ts/)
  assert.match(await read('lib/typert.host.mjs'), /\.\/shared\/contract\.js/)
  assert.match(await read('.gitignore'), /^lib\/$/m)
  const { PACKAGE, descriptors } = await import('../lib/shared/contract.js')
  assert.equal(PACKAGE, manifest.name)
  for (const descriptor of descriptors) assert.equal(descriptor.id, `${manifest.name}#pluginLogs/${descriptor.method}`)
})

test('package Host entry mounts without loading browser globals or changing plugin identity', async t => {
  const plugin = await import('@lemonel/dsh-plugin-logs')
  assert.equal(plugin.name, 'plugin-logs')
  const ctx = new Context()
  ctx.reflect.provide('agents', { get: () => undefined })
  ctx.reflect.provide('tools', {})
  const fiber = ctx.plugin(plugin, { capacity: 3 })
  t.after(() => fiber.dispose())
  await fiber.await()
  ctx.logger('entry-test').info('entry works')
  assert.equal(ctx.get('pluginLogs').tail(0, 10).entries.at(-1).text, 'entry works')
})

// Test actual compiled exports without appending statements to generated code.
test('frontend modules expose real isolated exports and registration remains lazy', async () => {
  const { Panel } = await import('../lib/frontend/panel.js')
  const { sourceOptions } = await import('../lib/frontend/display.js')
  const { zh, en } = await import('../lib/frontend/locale.js')
  assert.equal(typeof Panel, 'function')
  assert.deepEqual(sourceOptions([{ source: 'b' }], 'a'), [{ value: 'a', expired: true }, { value: 'b', expired: false }])
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  const { default: vm } = await import('node:vm')
  let registration
  vm.runInNewContext(await read('lib/client.js'), { window: { __ModuleLoader__: { load(value) { registration = value } } } })
  assert.equal(registration.id, '@lemonel/dsh-plugin-logs')
  assert.equal(typeof registration.factory, 'function')
})
