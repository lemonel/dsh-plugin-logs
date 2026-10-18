import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
export const installFlags = ['--prefer-offline', '--no-audit', '--no-fund']
// Deliberate source inputs, not a Git-cleanliness claim. Never copy an installed
// dependency, generated lib, archive, profile, or another plugin into a fixture.
export const sourceInputs = ['package.json', 'package-lock.json', 'build.mjs', 'tsconfig.json', '.gitignore', '.github', 'README.md', 'README.en.md', 'RELEASING.md', 'LICENSE', 'icon.svg', 'screenshots.json', 'docs', 'bundles', 'src', 'test']
const excluded = new Set(['node_modules', 'lib', '.git', '.cache', '.npm'])
const markerName = '.plugin-logs-verification'
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const isDsh = name => name.startsWith('@deepseek-ai/dsh-')
const within = (root, path) => path === root || path.startsWith(root + sep)
export const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
export const isMain = url => Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === url

export function supportedVersions(manifest) {
  const versions = manifest.engines?.dsh?.split(/\s*\|\|\s*/)
  assert.ok(versions?.length && versions.every(version => /^\d+\.\d+\.\d+-rc\.\d+$/.test(version)), 'engines.dsh must enumerate exact supported prereleases')
  return [...new Set(versions)]
}

export function pinDshDependencies(manifest, version) {
  assert.ok(supportedVersions(manifest).includes(version), `Unsupported DSH version: ${version}`)
  const pinned = structuredClone(manifest)
  for (const field of dependencyFields) {
    for (const name of Object.keys(pinned[field] || {})) {
      if (isDsh(name)) pinned[field][name] = version
    }
  }
  return pinned
}

export function dshLockEntries(lock) {
  return Object.entries(lock.packages || {}).flatMap(([path, metadata]) => {
    const match = /(?:^|\/)node_modules\/(@deepseek-ai\/dsh-[^/]+)$/.exec(path)
    return match ? [{ path, name: match[1], ...metadata }] : []
  })
}

export function validateLock(manifest, lock, expectedVersion) {
  assert.ok(lock.lockfileVersion >= 2 && lock.packages?.[''], 'A package-lock with package metadata is required')
  assert.equal(lock.name, manifest.name, 'Lockfile package name is stale')
  assert.equal(lock.version, manifest.version, 'Lockfile package version is stale')
  assert.equal(lock.packages[''].name, manifest.name)
  assert.equal(lock.packages[''].version, manifest.version)
  for (const field of dependencyFields) assert.deepEqual(lock.packages[''][field] || {}, manifest[field] || {}, `Stale lockfile ${field}`)
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (!path) continue
    assert.ok(!metadata.link, `Linked dependency is forbidden: ${path}`)
    assert.match(path, /^(?:node_modules\/)/, `Dependency outside node_modules: ${path}`)
    assert.match(metadata.resolved || '', /^https:\/\//, `Non-registry dependency: ${path}`)
    assert.ok(metadata.integrity, `Missing registry integrity: ${path}`)
  }
  const entries = dshLockEntries(lock)
  assert.ok(entries.length, 'No DSH packages in the lockfile')
  const versions = [...new Set(entries.map(entry => entry.version))]
  assert.equal(versions.length, 1, `Mixed DSH versions: ${versions.join(', ')}`)
  const version = expectedVersion || versions[0]
  assert.ok(supportedVersions(manifest).includes(version), `Locked DSH version is not supported: ${version}`)
  for (const entry of entries) assert.equal(entry.version, version, `${entry.path} must use DSH ${version}`)
  for (const field of dependencyFields) {
    for (const name of Object.keys(manifest[field] || {}).filter(isDsh)) {
      assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `Missing or mismatched direct DSH dependency: ${name}`)
    }
  }
  return version
}

export async function createWorkspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'plugin-logs-verification-')))
  const workspace = { root, token: randomUUID() }
  await writeFile(join(root, markerName), JSON.stringify(workspace))
  await mkdir(join(root, 'tmp'))
  await writeFile(join(root, 'npm-user.rc'), '')
  await writeFile(join(root, 'npm-global.rc'), '')
  return workspace
}

// Both deletion sites first validate the resolved absolute path and ownership.
export async function ownedPath(workspace, child = '') {
  assert.equal(resolve(workspace.root), workspace.root)
  assert.equal(await realpath(workspace.root), workspace.root)
  assert.ok(basename(workspace.root).startsWith('plugin-logs-verification-'))
  assert.deepEqual(await readJson(join(workspace.root, markerName)), workspace)
  const path = resolve(workspace.root, child)
  assert.ok(within(workspace.root, path), `Refusing path outside owned workspace: ${path}`)
  assert.ok(!within(path, resolve(projectRoot)), 'Refusing to remove the maintained project')
  const parent = path === workspace.root ? dirname(path) : await realpath(dirname(path))
  if (path !== workspace.root) assert.ok(within(workspace.root, parent), `Symlink escapes workspace: ${path}`)
  return path
}

export async function removeWorkspace(workspace) {
  const path = await ownedPath(workspace)
  await rm(path, { recursive: true })
}

export async function copySources(source, destination) {
  const root = await realpath(source)
  const target = resolve(destination)
  assert.ok(!within(root, target) && !within(target, root), 'Source copy must be outside the maintained project')
  const digest = createHash('sha256')
  async function copy(path) {
    const name = relative(root, path)
    const metadata = await lstat(path)
    assert.ok(!metadata.isSymbolicLink(), `Source symlinks are forbidden: ${name}`)
    if (metadata.isDirectory()) {
      await mkdir(join(target, name), { recursive: true })
      for (const child of (await readdir(path)).sort()) {
        if (!excluded.has(child) && !child.endsWith('.tgz')) await copy(join(path, child))
      }
    } else {
      assert.ok(metadata.isFile(), `Unsupported source entry: ${name}`)
      digest.update(name + '\0').update(await readFile(path)).update('\0')
      await copyFile(path, join(target, name))
    }
  }
  await mkdir(target, { recursive: true })
  for (const input of sourceInputs) await copy(join(root, input))
  return digest.digest('hex')
}

export function subprocessEnvironment(workspace, inherited = process.env) {
  const env = { ...inherited }
  // Do not inherit Node loaders, NODE_PATH, production omissions, workspaces, or
  // user/global npm configuration that could hide missing local dependencies.
  for (const key of Object.keys(env)) {
    if (/^(?:NODE_PATH|NODE_OPTIONS|NODE_REPL_EXTERNAL_MODULE|NODE_ENV)$/i.test(key) || /^npm_config_(?:force|legacy_peer_deps|global|prefix|ignore_scripts|omit|include|production|workspace|workspaces|node_options|userconfig|globalconfig)$/i.test(key)) delete env[key]
  }
  return {
    ...env, NODE_ENV: 'test',
    npm_config_force: 'false', npm_config_legacy_peer_deps: 'false',
    npm_config_global: 'false', npm_config_ignore_scripts: 'false',
    npm_config_include: 'dev', npm_config_package_lock: 'true',
    npm_config_userconfig: join(workspace.root, 'npm-user.rc'),
    npm_config_globalconfig: join(workspace.root, 'npm-global.rc'),
    TMPDIR: join(workspace.root, 'tmp'), TMP: join(workspace.root, 'tmp'), TEMP: join(workspace.root, 'tmp'),
  }
}

export function runNpm(args, { cwd, env, capture = false }) {
  console.log(`\n[verification] npm ${args.join(' ')} (cwd: ${cwd})`)
  const windows = process.platform === 'win32'
  const result = spawnSync(windows ? 'npm.cmd' : 'npm', args, {
    cwd, env, shell: windows, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) throw result.error
  assert.equal(result.signal, null, `npm ${args[0]} terminated by ${result.signal}`)
  assert.equal(result.status, 0, `npm ${args.join(' ')} failed${capture ? '\n' + result.stdout + result.stderr : ''}`)
  return capture ? result.stdout : undefined
}

export async function assertLocalDependencies(root, manifest, lock, version) {
  validateLock(manifest, lock, version)
  const modules = resolve(root, 'node_modules')
  assert.equal(await realpath(modules), modules, 'node_modules must be a local npm directory, not a global link')
  const required = new Set(dependencyFields.flatMap(field => Object.keys(manifest[field] || {})))
  // Explicit filesystem paths, not require.resolve/import.meta.resolve: neither
  // parent node_modules nor a global Host can satisfy the installation audit.
  for (const name of required) {
    const path = join(modules, name, 'package.json')
    assert.ok(within(modules, resolve(path)), `Invalid dependency name: ${name}`)
    const installed = await readJson(path)
    assert.equal(installed.name, name)
    assert.equal(installed.version, lock.packages[`node_modules/${name}`]?.version, `Direct dependency differs from lock: ${name}`)
  }
  let installedCount = 0
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (!path) continue
    const directory = resolve(root, path)
    assert.ok(within(modules, directory), `Dependency path escapes local node_modules: ${path}`)
    let actual
    try { actual = await realpath(directory) } catch (error) {
      if (error.code === 'ENOENT' && metadata.optional && !isDsh(path.split('node_modules/').at(-1))) continue
      throw error
    }
    assert.ok(within(modules, actual), `Dependency resolves outside local node_modules: ${path} -> ${actual}`)
    assert.ok(!(await lstat(directory)).isSymbolicLink(), `Linked dependency is forbidden: ${path}`)
    assert.equal((await readJson(join(directory, 'package.json'))).version, metadata.version, `Installed version differs from lock: ${path}`)
    installedCount++
  }
  return { installedCount, dshCount: dshLockEntries(lock).length }
}
