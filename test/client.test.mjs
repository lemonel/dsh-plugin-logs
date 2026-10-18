import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { Worker } from 'node:worker_threads'

function loadBundle(bundle, react, environment = {}) {
  let plugin
  const React = react || { createElement: (...args) => args, useState: () => [], useEffect() {}, useRef: () => ({ current: null }) }
  vm.runInNewContext(bundle, { setTimeout, clearTimeout, ...environment, window: { __ModuleLoader__: { load(value) { plugin = value.factory(name => { assert.equal(name, 'react'); return React }) } } } })
  return plugin
}
function workerFactory(main) {
  const worker = new Worker(`const {parentPort}=require('node:worker_threads'); const scope={postMessage:v=>parentPort.postMessage(v)}; (${main.toString()})(scope); parentPort.on('message',data=>scope.onmessage({data}));`, { eval: true })
  const adapter = { postMessage: value => worker.postMessage(value), terminate: () => worker.terminate() }
  worker.on('message', data => adapter.onmessage?.({ data }))
  worker.on('error', error => adapter.onerror?.(error))
  return adapter
}

test('built browser runtime supports exact source, regex OR, empty conditions and keyed errors', async t => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const plugin = loadBundle(bundle)
  const runner = plugin.createRegexRunner({ timeoutMs: 2000, workerFactory })
  t.after(() => runner.dispose())
  const rows = [
    { source: 'alpha', level: 'error', text: 'Connection TIMEOUT' },
    { source: 'beta', level: 'warn', text: 'disk failure' },
    { source: 'gamma', level: 'info', text: 'ready' },
  ]
  const selected = async (source, level, queries) => [...(await runner.run(rows, source, level, queries)).rows]
  assert.deepEqual(await selected('', '', 'timeout|failure'), rows.slice(0, 2))
  assert.deepEqual(await selected('alpha', 'error', ['timeout', 'failure']), rows.slice(0, 1))
  for (const source of ['alpha|beta', '^alpha$', '(']) assert.deepEqual(await selected(source, '', ''), [])
  assert.deepEqual(await selected('alpha', 'warn', 'timeout|failure'), [])
  assert.deepEqual(await selected('', '', '^beta '), rows.slice(1, 2))
  assert.deepEqual(await selected('', '', ['', '']), rows)
  assert.deepEqual(await selected('', '', ['', 'failure']), rows.slice(1, 2))
  assert.equal((await runner.run(rows, '', '', ['timeout', '('])).error.values.n, 2)
  assert.equal((await runner.run(rows, '', '', '(')).error.key, 'regexInvalid')
  assert.equal((await runner.run(rows, '', '', 'x'.repeat(201))).error.key, 'regexTooLong')
  assert.match(bundle, /全部来源/)
  assert.doesNotMatch(bundle, /或\/or/)
})

test('expired selected source remains explicit in dropdown options', async () => {
  const plugin = loadBundle(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
  const rows = Array.from({ length: 2000 }, () => ({ source: 'beta' }))
  const options = JSON.parse(JSON.stringify(plugin.sourceOptions(rows, 'alpha')))
  assert.deepEqual(options, [{ value: 'alpha', expired: true }, { value: 'beta', expired: false }])
})

test('Agent-scoped Remote resolves through Context.get without implicit inject', async () => {
  const { scopedRemote } = loadBundle(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))
  const scoped = { toolStatus: () => ({ ok: true, value: { enabled: true } }) }
  const binding = { ctx: new Proxy({ get(name) { assert.equal(name, 'remote.pluginLogs'); return scoped } }, { get(target, name) { if (name === 'remote') throw new Error('cannot get property without inject'); return target[name] } }) }
  assert.equal(scopedRemote(binding), scoped)
  assert.throws(() => scopedRemote({ ctx: { get: () => undefined } }), /尚未就绪/)
})

test('browser bundle registers bilingual dictionaries, remote, sidebar and disposal', async () => {
  const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  let tab, body, mount, dictionaries, activeLocale = 'zh', unmounted = 0
  const cleanups = []
  const translate = (key, values = {}) => (dictionaries[activeLocale][key] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''))
  const child = {
    effect: fn => { cleanups.push(fn()) },
    locale: { register(ns, dicts) { assert.equal(ns, 'pluginLogs'); dictionaries = dicts; return () => { dictionaries = null } }, bind() { return translate } },
    inject: (_, fn) => { fn(child); cleanups.push(() => { body = null }) },
    sessions: { using() {} },
    remote: { pluginLogs: { tail() {} }, async $mount(remote) { mount = remote; return () => { unmounted++ } } },
    sidebarRightTabs: { register(definition) { tab = definition; return () => { tab = null } } },
    slots: { inject: (_, callback) => { callback(); return () => { body = null } }, register(definition, component) { body = { definition, component }; return () => {} } },
  }
  const plugin = loadBundle(bundle)
  const dispose = await plugin.apply(child)
  assert.equal(mount.package, '@lemonel/dsh-plugin-logs')
  assert.equal(tab.kind, 'plugin-logs')
  assert.equal(tab.guide[0].title(), '插件日志')
  assert.equal(body.definition.locale, 'pluginLogs')
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort())
  assert.equal(dictionaries.zh.or, '或')
  assert.equal(dictionaries.en.or, 'or')
  assert.match(translate('regexInvalid', { n: 1, error: 'bad' }), /搜索日志正则 1无效/)
  activeLocale = 'en'
  assert.equal(tab.title(), 'Plugin logs')
  assert.equal(tab.guide[0].description(), 'View runtime logs by plugin')
  assert.match(translate('regexInvalid', { n: 2, error: 'bad' }), /Search log regex 2 is invalid/)
  assert.equal(body.definition.key, tab.id)
  assert.equal(body.definition.inject().service, child.remote.pluginLogs)
  assert.match(tab.guide[0].icon({ size: 26 })[1].src, /^data:image\/svg\+xml,/)
  cleanups.reverse().forEach(cleanup => cleanup?.())
  await dispose()
  assert.equal(tab, null)
  assert.equal(body, null)
  assert.equal(unmounted, 1)
})

test('bilingual dictionaries keep placeholder parity and a deterministic fallback', async () => {
  const { zh, en, fallback } = await import('../lib/frontend/locale.js')
  const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(zh)) assert.deepEqual(placeholders(zh[key]), placeholders(en[key]), key)
  assert.equal(fallback('missing.key'), 'missing.key')
  assert.equal(fallback('dropped', { n: 3 }), '主机缓冲区已丢失 3 条未读取日志')
})
