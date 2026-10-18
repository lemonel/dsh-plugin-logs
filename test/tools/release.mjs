import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// SemVer 2.0: numeric prerelease identifiers cannot contain leading zeroes.
const number = '(?:0|[1-9][0-9]*)'
const identifier = `(?:${number}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`
const semver = new RegExp(`^${number}\\.${number}\\.${number}(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)

export function validateRelease(tag, manifest, lock) {
  assert.equal(typeof tag, 'string', 'Release tag is required')
  assert.ok(tag.startsWith('v'), 'Release tag must start with v')
  const version = tag.slice(1)
  const match = semver.exec(version)
  assert.ok(match, 'Release tag must contain a valid semantic version')
  assert.equal(manifest?.version, version, 'Tag and package version differ')
  assert.equal(lock?.version, version, 'Tag and lock version differ')
  assert.equal(lock?.packages?.['']?.version, version, 'Tag and lock root version differ')
  assert.equal(typeof manifest?.name, 'string', 'Package name is required')
  assert.match(manifest.name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/, 'Unsafe package name')
  assert.equal(lock?.name, manifest.name, 'Package and lock name differ')
  assert.equal(lock?.packages?.['']?.name, manifest.name, 'Package and lock root name differ')
  return { version, prerelease: Boolean(match[1]), filename: `${manifest.name.replace(/^@/, '').replace('/', '-')}-${version}.tgz` }
}

export function parsePackageOutput(args) {
  if (args.length === 0) return undefined
  assert.equal(args.length, 2, 'Usage: check-package.mjs [--output-dir DIRECTORY]')
  assert.equal(args[0], '--output-dir', 'Unknown package check option')
  assert.ok(args[1] && !args[1].startsWith('-'), '--output-dir requires a directory')
  return resolve(args[1])
}

// Called only after the real archive has passed every package smoke check.
// Copy those exact bytes, never run a second (unverified) npm pack.
export async function exportValidatedPackage(archive, destination) {
  const filename = basename(archive)
  assert.match(filename, /^[A-Za-z0-9._+-]+\.tgz$/, 'Unsafe archive filename')
  await mkdir(destination, { recursive: true })
  const target = join(destination, filename)
  await copyFile(archive, target, constants.COPYFILE_EXCL)
  const checksum = createHash('sha256').update(await readFile(target)).digest('hex')
  await writeFile(`${target}.sha256`, `${checksum}  ${filename}\n`, { flag: 'wx' })
  return target
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['validate'], 'Usage: release.mjs validate (RELEASE_TAG required)')
  const root = new URL('../../', import.meta.url)
  const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'))
  const metadata = validateRelease(process.env.RELEASE_TAG, manifest, lock)
  const output = Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join('')
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output)
  process.stdout.write(output)
}
