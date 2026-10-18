import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, copyFile, cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import {
  assertLocalDependencies, copySources, createWorkspace, ownedPath, pinDshDependencies,
  projectRoot, readJson, removeWorkspace, sourceInputs,
  subprocessEnvironment, supportedVersions, validateLock,
} from './tools/installation-fixture.mjs'

async function workspaceFor(t) {
  const workspace = await createWorkspace()
  t.after(() => removeWorkspace(workspace))
  return workspace
}

function node(args, cwd, env) {
  const result = spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  return result
}

const dependency = '@deepseek-ai/dsh-scope'
const version = '0.2.1-rc.1'
function minimalInstallation() {
  const manifest = { name: 'dependency-isolation-fixture', version: '1.0.0', type: 'module', engines: { dsh: version }, peerDependencies: { [dependency]: version } }
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
    '': structuredClone(manifest),
    [`node_modules/${dependency}`]: { version, resolved: `https://registry.npmjs.org/${dependency}/-/dsh-scope-${version}.tgz`, integrity: 'sha512-fixture' },
  } }
  return { manifest, lock }
}

async function fakeParentPackage(workspace) {
  const root = join(workspace.root, 'node_modules', dependency)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: dependency, version, type: 'module', exports: './index.js' }))
  await writeFile(join(root, 'index.js'), "export const source = 'forbidden-parent-host'\n")
  return root
}

test('compatibility pinning covers every direct DSH field without changing non-DSH dependencies or source manifest', async () => {
  const manifest = await readJson(join(projectRoot, 'package.json'))
  const original = JSON.stringify(manifest)
  for (const target of supportedVersions(manifest)) {
    const pinned = pinDshDependencies(manifest, target)
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, value] of Object.entries(manifest[field] || {})) assert.equal(pinned[field][name], name.startsWith('@deepseek-ai/dsh-') ? target : value)
    }
    assert.equal(pinned.name, manifest.name)
    assert.equal(pinned.engines.dsh, manifest.engines.dsh)
  }
  assert.equal(JSON.stringify(manifest), original)
  assert.throws(() => pinDshDependencies(manifest, '0.0.0-rc.0'), /Unsupported DSH/)
})

test('lock audit rejects stale roots, mixed transitive DSH versions and local/global link sources', () => {
  const { manifest, lock } = minimalInstallation()
  assert.equal(validateLock(manifest, lock), version)
  const mixed = structuredClone(lock)
  mixed.packages[`node_modules/fixture/node_modules/${dependency}`] = { ...lock.packages[`node_modules/${dependency}`], version: '0.2.0-rc.2' }
  assert.throws(() => validateLock(manifest, mixed), /Mixed DSH/)
  const linked = structuredClone(lock)
  linked.packages[`node_modules/${dependency}`].link = true
  assert.throws(() => validateLock(manifest, linked), /Linked dependency/)
  const local = structuredClone(lock)
  local.packages[`node_modules/${dependency}`].resolved = 'file:/forbidden/global/host'
  assert.throws(() => validateLock(manifest, local), /Non-registry dependency/)
  const stale = structuredClone(lock)
  stale.packages[''].peerDependencies[dependency] = '0.2.0-rc.2'
  assert.throws(() => validateLock(manifest, stale), /Stale lockfile peerDependencies/)
})

test('independent source copying includes the lock and all tests but excludes installed dependencies and generated output', async t => {
  const workspace = await workspaceFor(t)
  const source = join(workspace.root, 'source')
  await mkdir(source)
  for (const input of sourceInputs) {
    if (['bundles', 'src', 'test'].includes(input)) {
      await mkdir(join(source, input))
      await writeFile(join(source, input, 'source.txt'), input)
    } else await writeFile(join(source, input), input)
  }
  for (const path of ['node_modules', 'lib', 'test/node_modules', 'test/lib']) {
    await mkdir(join(source, path), { recursive: true })
    await writeFile(join(source, path, 'must-not-copy.txt'), 'forbidden')
  }
  const destination = join(workspace.root, 'copied')
  assert.match(await copySources(source, destination), /^[0-9a-f]{64}$/)
  assert.equal(await readFile(join(destination, 'package-lock.json'), 'utf8'), 'package-lock.json')
  assert.equal(await readFile(join(destination, 'test/source.txt'), 'utf8'), 'test')
  for (const path of ['node_modules', 'lib', 'test/node_modules', 'test/lib']) await assert.rejects(access(join(destination, path)), { code: 'ENOENT' })
})

test('workspace deletion guards reject traversal, foreign ownership and symlink escapes', async t => {
  const workspace = await workspaceFor(t)
  const foreign = await workspaceFor(t)
  assert.equal(await ownedPath(workspace), workspace.root)
  await assert.rejects(ownedPath(workspace, '../not-owned'), /outside owned workspace/)
  await assert.rejects(ownedPath(workspace, projectRoot), /outside owned workspace/)
  await assert.rejects(ownedPath({ ...workspace, token: 'wrong-owner' }))
  await symlink(foreign.root, join(workspace.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(ownedPath(workspace, 'escape/never-delete'), /Symlink escapes workspace/)
  await assert.rejects(copySources(projectRoot, join(projectRoot, 'never-copy')), /outside the maintained project/)
})

test('subprocess environment removes global Node loaders and npm bypasses while preserving the download cache', async t => {
  const workspace = await workspaceFor(t)
  const env = subprocessEnvironment(workspace, {
    NODE_PATH: '/global/host', NODE_OPTIONS: '--import=/global/loader.mjs', NODE_ENV: 'production',
    npm_config_force: 'true', npm_config_legacy_peer_deps: 'true', npm_config_global: 'true',
    npm_config_omit: 'dev', npm_config_ignore_scripts: 'true', npm_config_workspace: 'other-plugin',
    npm_config_cache: '/download-cache',
  })
  assert.equal(env.NODE_PATH, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.NODE_ENV, 'test')
  for (const name of ['force', 'legacy_peer_deps', 'global', 'ignore_scripts']) assert.equal(env[`npm_config_${name}`], 'false')
  assert.equal(env.npm_config_omit, undefined)
  assert.equal(env.npm_config_workspace, undefined)
  assert.equal(env.npm_config_include, 'dev')
  assert.equal(env.npm_config_cache, '/download-cache')
})

test('missing local Host dependencies fail even when Node could import a complete parent Host package', async t => {
  const workspace = await workspaceFor(t)
  await fakeParentPackage(workspace)
  const fixture = join(workspace.root, 'project')
  await mkdir(join(fixture, 'node_modules'), { recursive: true })
  const { manifest, lock } = minimalInstallation()
  await writeFile(join(fixture, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(fixture, 'probe.mjs'), `import { source } from '${dependency}'\nconsole.log(source)\n`)
  // Prove this is a real contamination risk, not merely an empty fixture: the
  // ordinary Node resolver finds the parent's package, but our audit must not.
  const contaminated = node([join(fixture, 'probe.mjs')], fixture, subprocessEnvironment(workspace))
  assert.equal(contaminated.status, 0, contaminated.stderr)
  assert.match(contaminated.stdout, /forbidden-parent-host/)
  await assert.rejects(assertLocalDependencies(fixture, manifest, lock, version), { code: 'ENOENT' })
})

test('an explicitly audited local dependency cannot be a symlink to a parent or global Host', async t => {
  const workspace = await workspaceFor(t)
  const parent = await fakeParentPackage(workspace)
  const fixture = join(workspace.root, 'project')
  await mkdir(join(fixture, 'node_modules/@deepseek-ai'), { recursive: true })
  await symlink(parent, join(fixture, 'node_modules', dependency), process.platform === 'win32' ? 'junction' : 'dir')
  const { manifest, lock } = minimalInstallation()
  await assert.rejects(assertLocalDependencies(fixture, manifest, lock, version), /outside local node_modules|Linked dependency/)
})

test('real build script fails without local esbuild instead of taking cwd or NODE_PATH dependencies', async t => {
  const workspace = await workspaceFor(t)
  const fixture = join(workspace.root, 'project')
  await mkdir(fixture)
  await copyFile(join(projectRoot, 'build.mjs'), join(fixture, 'build.mjs'))
  const env = { ...subprocessEnvironment(workspace), NODE_PATH: join(projectRoot, 'node_modules') }
  const result = node([join(fixture, 'build.mjs')], projectRoot, env)
  assert.notEqual(result.status, 0, 'Uninstalled build must not succeed from another cwd or NODE_PATH')
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/)
  assert.match(result.stderr, /esbuild/)
})

test('real compiled Host static imports fail without peers despite available cwd and global-style NODE_PATH', async t => {
  const workspace = await workspaceFor(t)
  const fixture = join(workspace.root, 'project')
  await mkdir(fixture)
  await writeFile(join(fixture, 'package.json'), JSON.stringify({ type: 'module' }))
  // Only this negative fixture copies build output; installation tools always
  // exclude lib and rebuild from source. No runtime dependency is copied here.
  await cp(join(projectRoot, 'lib'), join(fixture, 'lib'), { recursive: true })
  await writeFile(join(fixture, 'probe.mjs'), "import './lib/backend_index.js'\nconsole.log('unexpected-host-success')\n")
  const env = { ...subprocessEnvironment(workspace), NODE_PATH: [join(projectRoot, 'node_modules'), '/usr/lib/node_modules'].join(delimiter) }
  const result = node([join(fixture, 'probe.mjs')], projectRoot, env)
  assert.notEqual(result.status, 0, 'Uninstalled Host must not take peers from the invoking cwd or a global installation')
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/)
  assert.match(result.stderr, /@deepseek-ai\/(?:schemastery|dsh-typert-protocol|dsh-scope|dsh-tools)/)
  assert.doesNotMatch(result.stdout, /unexpected-host-success/)
})
