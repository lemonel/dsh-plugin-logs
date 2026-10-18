import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = name => readFile(new URL(name, root), 'utf8')
const readBytes = name => readFile(new URL(name, root))
const manifest = JSON.parse(await read('package.json'))
const relativeLinks = text => [...text.matchAll(/\[[^\]]*\]\((?:<)?(\.\/[^)>\s#]+)(?:#[^)]*)?(?:>)?\)/g)].map(match => match[1])

test('the paired Chinese and English READMEs cover the same sections and resolve their local links', async () => {
  const zh = await read('README.md')
  const en = await read('README.en.md')
  assert.match(zh, /\[English\]\(\.\/README\.en\.md\)/)
  assert.match(en, /\[中文\]\(\.\/README\.md\)/)
  const sections = text => text.split('\n').filter(line => line.startsWith('## ')).length
  assert.equal(sections(zh), sections(en))
  for (const version of manifest.engines.dsh.split(' || ')) {
    assert.ok(zh.includes(version), `Chinese README must declare supported DSH ${version}`)
    assert.ok(en.includes(version), `English README must declare supported DSH ${version}`)
  }
  for (const text of [zh, en]) {
    assert.match(text, /plugin_logs_query/)
    assert.match(text, /plugin_logs_sources/)
    assert.match(text, /Worker/)
    assert.match(text, /capacity/)
    assert.match(text, /npm run check:compat/)
  }
  for (const link of new Set([...relativeLinks(zh), ...relativeLinks(en)])) await access(new URL(link, root))
})

test('user documents contain no leftover personal package prefix', async () => {
  for (const name of ['README.md', 'README.en.md', 'RELEASING.md']) {
    assert.doesNotMatch(await read(name), /hsx/i, `${name} must not mention the old personal package prefix`)
  }
})

test('package metadata ships both user documents and the market icon', async () => {
  assert.equal(manifest.name, '@lemonel/dsh-plugin-logs')
  assert.match(manifest.description, /\S/)
  assert.equal(manifest.icon, './icon.svg')
  assert.equal(manifest.dsh.bundle.patch, './bundles/plugin-logs.patch.yml')
  for (const path of ['icon.svg', 'README.md', 'README.en.md', 'RELEASING.md', 'LICENSE', 'docs', 'screenshots.json', 'bundles', 'lib']) {
    assert.ok(manifest.files.includes(path), `Package files must include ${path}`)
  }
  await access(new URL(manifest.icon, root))
  await access(new URL(manifest.dsh.bundle.patch, root))
})

test('the market screenshots exist, are real PNG images and match the READMEs', async () => {
  const screenshots = JSON.parse(await read('screenshots.json'))
  assert.deepEqual(screenshots, ['docs/panel-zh.png', 'docs/panel-en.png'])
  for (const path of screenshots) {
    const bytes = await readBytes(path)
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path} must be a PNG`)
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    assert.ok(width >= 600 && height >= 600, `${path} is too small: ${width}x${height}`)
    assert.ok(bytes.length < 300 * 1024, `${path} is unreasonably large`)
  }
  assert.match(await read('README.md'), /!\[[^\]]*\]\(docs\/panel-zh\.png\)/)
  assert.match(await read('README.en.md'), /!\[[^\]]*\]\(docs\/panel-en\.png\)/)
})

test('the market icon is a self-contained, labelled SVG', async () => {
  const svg = await read('icon.svg')
  assert.match(svg, /^<svg\b[^>]*viewBox="0 0 64 64"/)
  assert.match(svg, /role="img"/)
  assert.match(svg, /aria-labelledby="title desc"/)
  assert.match(svg, /<title id="title">[^<]+<\/title>/)
  assert.match(svg, /<desc id="desc">[^<]+<\/desc>/)
  assert.doesNotMatch(svg, /<script\b/i)
  assert.doesNotMatch(svg, /\son[a-z]+\s*=/i)
  assert.doesNotMatch(svg, /\b(?:xlink:)?href\s*=/i)
  assert.doesNotMatch(svg, /<foreignObject\b|<image\b|@import\b/i)
  assert.doesNotMatch(svg.replace(/\sxmlns(?::xlink)?="[^"]*"/g, ''), /https?:\/\//i)
  for (const match of svg.matchAll(/url\(([^)]*)\)/g)) assert.match(match[1], /^#[A-Za-z][\w-]*$/)
})
