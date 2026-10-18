import assert from 'node:assert/strict'
import { access, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertLocalDependencies, copySources, createWorkspace, installFlags, isMain,
  ownedPath, pinDshDependencies, projectRoot, readJson, removeWorkspace,
  runNpm, subprocessEnvironment, supportedVersions, validateLock,
} from './installation-fixture.mjs'

export async function verifyInstallation({ version, keep = false } = {}) {
  const originalManifest = await readFile(join(projectRoot, 'package.json'), 'utf8')
  const originalLock = await readFile(join(projectRoot, 'package-lock.json'), 'utf8')
  const sourceManifest = JSON.parse(originalManifest)
  const lockedVersion = validateLock(sourceManifest, JSON.parse(originalLock))
  const targetVersion = version || lockedVersion
  assert.ok(supportedVersions(sourceManifest).includes(targetVersion), `Unsupported DSH version: ${targetVersion}`)
  const workspace = await createWorkspace()
  const root = join(workspace.root, 'project')
  const env = subprocessEnvironment(workspace)
  console.log(`[verification] Independent clean source copy; DSH ${targetVersion}; workspace: ${workspace.root}`)
  let succeeded = false
  try {
    const sourceDigest = await copySources(projectRoot, root)
    await assert.rejects(access(join(root, 'node_modules')), { code: 'ENOENT' })
    await assert.rejects(access(join(root, 'lib')), { code: 'ENOENT' })
    assert.equal(await readFile(join(root, 'package.json'), 'utf8'), originalManifest, 'Manifest changed while copying source; retry after edits settle')
    assert.equal(await readFile(join(root, 'package-lock.json'), 'utf8'), originalLock, 'Lock changed while copying source; retry after edits settle')
    if (targetVersion !== lockedVersion) {
      const pinned = pinDshDependencies(sourceManifest, targetVersion)
      await writeFile(join(root, 'package.json'), JSON.stringify(pinned, null, 2) + '\n')
      // Do not let npm retain the other release's transitive graph. Generate a
      // normal registry lock in this owned copy, then prove npm ci can reuse it.
      const copiedLock = await ownedPath(workspace, 'project/package-lock.json')
      await unlink(copiedLock)
      runNpm(['install', ...installFlags], { cwd: root, env })
    }
    const manifest = await readJson(join(root, 'package.json'))
    const lockText = await readFile(join(root, 'package-lock.json'), 'utf8')
    const lock = JSON.parse(lockText)
    validateLock(manifest, lock, targetVersion)
    runNpm(['ci', ...installFlags], { cwd: root, env })
    assert.equal(await readFile(join(root, 'package-lock.json'), 'utf8'), lockText, 'npm ci must not rewrite the lockfile')
    const dependencies = await assertLocalDependencies(root, manifest, lock, targetVersion)
    runNpm(['ls', '--all', '--json'], { cwd: root, env, capture: true })
    runNpm(['run', 'typecheck'], { cwd: root, env })
    runNpm(['run', 'build'], { cwd: root, env })
    runNpm(['test'], { cwd: root, env })
    // This existing checker runs real npm pack (including prepack), inspects the
    // actual tgz, extracts it, and smoke-tests the Host, RPC and browser entries.
    runNpm(['run', 'check:package'], { cwd: root, env })
    assert.equal(await readFile(join(projectRoot, 'package.json'), 'utf8'), originalManifest, 'Maintained manifest changed during verification')
    assert.equal(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'), originalLock, 'Maintained lock changed during verification')
    const summary = { dsh: targetVersion, lock: targetVersion === lockedVersion ? 'source lock reused unchanged' : 'isolated npm install -> npm ci', sourceDigest, ...dependencies }
    console.log('\n[verification] PASSED ' + JSON.stringify(summary))
    succeeded = true
    return summary
  } finally {
    if (succeeded && !keep) {
      await removeWorkspace(workspace)
      console.log(`[verification] Removed owned workspace: ${workspace.root}`)
    } else console.log(`[verification] Retained workspace for inspection: ${workspace.root}`)
  }
}

export function parseArguments(args) {
  const options = { keep: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--keep') options.keep = true
    else if (arg === '--dsh-version') {
      assert.ok(args[index + 1] && !args[index + 1].startsWith('-'), '--dsh-version requires an exact version')
      assert.equal(options.version, undefined, '--dsh-version may be supplied only once')
      options.version = args[++index]
    } else if (arg === '--help') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

if (isMain(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) console.log('Usage: node test/tools/verify-install.mjs [--dsh-version VERSION] [--keep]\nNo version: reuse the source lock. --keep: retain the successful isolated copy and actual package archive. Failures are always retained.')
  else await verifyInstallation(options)
}
