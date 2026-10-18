import assert from 'node:assert/strict'
import { join } from 'node:path'
import { isMain, projectRoot, readJson, supportedVersions } from './installation-fixture.mjs'
import { verifyInstallation } from './verify-install.mjs'

export async function verifyCompatibility({ keep = false } = {}) {
  const versions = supportedVersions(await readJson(join(projectRoot, 'package.json')))
  const results = []
  for (const version of versions) results.push(await verifyInstallation({ version, keep }))
  console.log('\n[verification] Compatibility matrix PASSED ' + JSON.stringify(results))
  return results
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  assert.ok(args.every(arg => arg === '--keep' || arg === '--help'), 'Usage: node test/tools/compatibility-matrix.mjs [--keep]')
  if (args.includes('--help')) console.log('Usage: node test/tools/compatibility-matrix.mjs [--keep]\nRuns a separate clean-source installation, full test suite and actual pack check for every exact engines.dsh version.')
  else await verifyCompatibility({ keep: args.includes('--keep') })
}
