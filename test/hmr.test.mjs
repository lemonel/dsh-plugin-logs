import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { PluginLogs } from '../lib/backend/host.js'

test('Host reload releases exporter and remote service; replacement starts with a fresh buffer', async () => {
  const ctx = new Context()
  ctx.reflect.provide('agents', { get: () => undefined })
  ctx.reflect.provide('tools', {})
  const initialExporters = ctx.logger.exporters.size
  const first = ctx.plugin(PluginLogs, { capacity: 3 })
  await first.await()
  assert.equal(ctx.logger.exporters.size, initialExporters + 1)
  ctx.logger('hmr-test').info('before')
  const oldPage = ctx.pluginLogs.tail(0, 10)
  assert.equal(oldPage.entries.length, 1)
  await first.dispose()
  assert.equal(ctx.logger.exporters.size, initialExporters)
  assert.equal(ctx.pluginLogs, undefined)

  const replacement = ctx.plugin(PluginLogs, { capacity: 3 })
  await replacement.await()
  assert.equal(ctx.logger.exporters.size, initialExporters + 1)
  const empty = ctx.pluginLogs.tail(0, 10)
  assert.deepEqual(empty, { entries: [], cursor: 0, dropped: 0, epoch: empty.epoch, reset: false })
  assert.notEqual(empty.epoch, oldPage.epoch)
  ctx.logger('hmr-test').warn('after')
  const resumed = ctx.pluginLogs.tail(oldPage.cursor, 10, oldPage.epoch)
  assert.equal(resumed.reset, true)
  assert.equal(resumed.dropped, 0)
  assert.equal(resumed.entries.length, 1)
  await replacement.dispose()
  assert.equal(ctx.logger.exporters.size, initialExporters)
})
