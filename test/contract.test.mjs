import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { descriptors, remote } from '../lib/shared/contract.js'
import { PluginLogs } from '../lib/backend/host.js'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { Config } from '../lib/backend_index.js'

test('Host method marker and client descriptor agree', async t => {
  const ctx = new Context()
  ctx.reflect.provide('agents', { get: () => undefined })
  ctx.reflect.provide('tools', {})
  const fiber = ctx.plugin(PluginLogs, {})
  await fiber.await()
  t.after(() => fiber.dispose())
  assert.equal(remote.package, '@lemonel/dsh-plugin-logs')
  assert.deepEqual(descriptors.map(item => item.id), ['@lemonel/dsh-plugin-logs#pluginLogs/tail', '@lemonel/dsh-plugin-logs#pluginLogs/toolStatus', '@lemonel/dsh-plugin-logs#pluginLogs/setToolEnabled'])
  assert.equal(descriptors[0].method, 'tail')
  assert.equal(descriptors[0].namespace, 'pluginLogs')
  assert.deepEqual(remoteMethods(ctx.get('pluginLogs')), [
    { method: 'tail', invocation: { kind: 'direct' } },
    { method: 'toolStatus', invocation: { kind: 'context', context: 'agent' } },
    { method: 'setToolEnabled', invocation: { kind: 'context', context: 'agent' } },
  ])
  assert.deepEqual(descriptors.slice(1).map(item => item.invocation.context), ['agent', 'agent'])
  assert.deepEqual(descriptors.slice(1).map(item => item.invocation.codec.typeSymbol), ['@deepseek-ai/dsh-session/types#SessionId', '@deepseek-ai/dsh-session/types#SessionId'])
})
test('remote codecs validate bounded cursor and page size', () => {
  const [cursor, limit] = descriptors[0].parameters.map(item => item.codec.create().parse)
  assert.equal(descriptors[2].parameters[0].codec.create().parse(true), true)
  assert.throws(() => descriptors[2].parameters[0].codec.create().parse('true'))
  assert.equal(cursor(0), 0)
  assert.equal(limit(500), 500)
  assert.throws(() => cursor(-1))
  assert.throws(() => limit(501))
  const epoch = descriptors[0].parameters[2].codec.create().parse
  assert.equal(epoch(''), '')
  assert.equal(epoch(undefined), '')
  assert.equal(epoch('uuid'), 'uuid')
  assert.equal(epoch('x'.repeat(100)), 'x'.repeat(100))
  assert.throws(() => epoch(123))
  assert.throws(() => epoch('x'.repeat(101)))
})
test('page codec rejects unsafe rows and capacity schema rejects fractional values', () => {
  const parse = descriptors[0].result.create().parse
  const row = { sequence: 1, time: 123, source: 'test', level: 'info', text: 'ok' }
  const page = { entries: [row], cursor: 1, dropped: 0, epoch: 'uuid', reset: false }
  assert.equal(parse(page), page)
  for (const change of [{ time: 1e20 }, { text: 'x'.repeat(4097) }, { source: 'x'.repeat(161) }, { level: 'fatal' }, { sequence: 0 }]) {
    assert.throws(() => parse({ ...page, entries: [{ ...row, ...change }] }))
  }
  assert.throws(() => parse({ ...page, reset: undefined }))
  assert.throws(() => parse({ ...page, dropped: -1 }))
  assert.throws(() => parse({ ...page, cursor: 900 }))
  assert.throws(() => parse({ ...page, epoch: 'x'.repeat(101) }))
  const boundedEpoch = { ...page, epoch: 'x'.repeat(100) }
  assert.equal(parse(boundedEpoch), boundedEpoch)
  assert.equal(Config({ capacity: 2000 }).capacity, 2000)
  assert.throws(() => Config({ capacity: 1.5 }))
})
