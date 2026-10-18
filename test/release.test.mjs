import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { exportValidatedPackage, parsePackageOutput, validateRelease } from './tools/release.mjs'

function inputs(version = '1.2.3') {
  const manifest = { name: '@lemonel/dsh-plugin-logs', version }
  const lock = { ...manifest, packages: { '': { ...manifest } } }
  return [manifest, lock]
}

test('release versions require exact SemVer tag/package/lock agreement', () => {
  for (const version of ['0.0.0', '1.2.3', '1.2.3+build.01', '1.2.3-rc.1', '1.2.3-0', '1.2.3-1a+build']) {
    const result = validateRelease(`v${version}`, ...inputs(version))
    assert.equal(result.version, version)
    assert.equal(result.prerelease, version.split('+')[0].includes('-'))
    assert.equal(result.filename, `lemonel-dsh-plugin-logs-${version}.tgz`)
  }
  for (const version of ['01.2.3', '1.02.3', '1.2', '1.2.3.4', '1.2.3-01', '1.2.3-rc.01', '1.2.3-', '1.2.3+', '1.2.3-a..b', '1.2.3+x/y', '1.2.3\n']) {
    assert.throws(() => validateRelease(`v${version}`, ...inputs(version)))
  }
  for (const tag of [undefined, '1.2.3', 'V1.2.3', 'v1.2.4', 'refs/tags/v1.2.3']) {
    assert.throws(() => validateRelease(tag, ...inputs()))
  }
  for (const mutate of [
    (p, l) => { p.version = '1.2.4' },
    (p, l) => { l.version = '1.2.4' },
    (p, l) => { l.packages[''].version = '1.2.4' },
    (p, l) => { delete l.packages },
    (p, l) => { l.name = 'other' },
    (p, l) => { l.packages[''].name = 'other' },
    (p, l) => { p.name = '../bad' },
  ]) {
    const [manifest, lock] = inputs()
    mutate(manifest, lock)
    assert.throws(() => validateRelease('v1.2.3', manifest, lock))
  }
})

test('optional package output has a strict, explicit CLI', () => {
  assert.equal(parsePackageOutput([]), undefined)
  assert.equal(parsePackageOutput(['--output-dir', tmpdir()]), tmpdir())
  for (const args of [['--output-dir'], ['--unknown', 'x'], ['--output-dir', '--other'], ['--output-dir', 'x', 'y']]) {
    assert.throws(() => parsePackageOutput(args))
  }
})

test('export preserves verified archive bytes, emits SHA256 and refuses overwrite', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'plugin-logs-release-test-'))
  // This exact mkdtemp-owned path is the only cleanup target.
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const archive = join(workspace, 'package-1.2.3.tgz')
  const bytes = Buffer.from('already validated archive bytes\0\xff')
  await writeFile(archive, bytes)
  const output = join(workspace, 'export')
  const target = await exportValidatedPackage(archive, output)
  assert.deepEqual(await readFile(target), bytes)
  const hash = createHash('sha256').update(bytes).digest('hex')
  assert.equal(await readFile(`${target}.sha256`, 'utf8'), `${hash}  package-1.2.3.tgz\n`)
  assert.deepEqual((await readdir(output)).sort(), ['package-1.2.3.tgz', 'package-1.2.3.tgz.sha256'])
  await assert.rejects(exportValidatedPackage(archive, output), { code: 'EEXIST' })
  await assert.rejects(exportValidatedPackage(join(workspace, 'bad file.tgz'), output), /Unsafe archive filename/)
})

test('release reuses CI, exports only checked archive, and isolates write permission', async () => {
  const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
  const ci = await read('.github/workflows/ci.yml')
  assert.match(ci, /push:\n    branches: \['\*\*'\]/)
  assert.match(ci, /  pull_request:/)
  assert.match(ci, /  workflow_dispatch:/)
  assert.match(ci, /  workflow_call:/)
  assert.doesNotMatch(ci, /tags:/)
  const release = await read('.github/workflows/release.yml')
  assert.match(release, /uses: \.\/\.github\/workflows\/ci\.yml/)
  assert.match(release, /npm ci --prefer-offline --no-audit --no-fund/)
  assert.match(release, /npm run check:package -- --output-dir/)
  const writer = release.split('\n  release:\n')[1]
  assert.match(writer, /contents: write/)
  assert.match(writer, /GH_TOKEN: \$\{\{ github.token \}\}/)
  assert.doesNotMatch(writer, /uses: actions\/checkout|run: npm|npm (?:ci|install|pack)|node test\//)
  assert.match(writer, /sha256sum/)
  assert.match(writer, /git\/tags\/\$sha/)
  assert.match(writer, /\$sha" == "\$TESTED_SHA/)
  assert.match(writer, /Release already exists/)
  assert.match(writer, /--verify-tag/)
  assert.match(writer, /--prerelease="\$PRERELEASE"/)
  const checker = await read('test/tools/check-package.mjs')
  assert.ok(checker.indexOf('exportValidatedPackage(archive, outputDirectory)') > checker.indexOf("assert.equal(typeof browser.apply, 'function')"))
})
