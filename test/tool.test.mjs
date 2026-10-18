import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { PluginLogs } from '../lib/backend/host.js'
import { queryLogs, listLogSources, TOOL_NAME, SOURCES_TOOL_NAME } from '../lib/backend/query.js'

function agent(ctx, id, header = {}) {
  const value = { id, session: { id, header } }
  const scope = createScope(ctx, value)
  value.ctx = scope.ctx
  return { value, scope }
}

async function lifecycle(t) {
  const ctx = new Context()
  ctx.reflect.provide('systemPrompt', { tools: () => () => {} })
  const toolsFiber = ctx.plugin(ToolRuntime, { mode: 'native' })
  await toolsFiber.await()
  const agents = new Map()
  ctx.reflect.provide('agents', { get: id => agents.get(id) })
  const owner = ctx.plugin({ name: 'independent-agents', inject: ['agents', 'tools'], apply() {} })
  await owner.await()
  const items = ['first', 'second'].map(id => agent(owner.ctx, id))
  for (const item of items) agents.set(item.value.id, item.value)
  let fiber
  const start = async () => {
    fiber = ctx.plugin(PluginLogs, {})
    await fiber.await()
    return fiber
  }
  t.after(async () => {
    await fiber?.dispose()
    for (const item of items) await item.scope.dispose()
    await owner.dispose()
    await toolsFiber.dispose()
  })
  const scoped = item => item.value.ctx.get('pluginLogs')
  const assertTools = present => {
    for (const item of items) {
      assert.notEqual(item.value.ctx.fiber.uid, null)
      for (const name of [TOOL_NAME, SOURCES_TOOL_NAME]) assert.equal(ctx.tools.get(name, item.value)?.name, present ? name : undefined)
    }
  }
  return { ctx, items, start, scoped, assertTools }
}

test('host tail forwards the optional buffer epoch', () => {
  const calls = []
  const result = {}
  const host = Object.create(PluginLogs.prototype)
  host.records = { tail: (...args) => { calls.push(args); return result } }
  assert.equal(host.tail(7, 12, 'previous-epoch'), result)
  assert.equal(host.tail(0, 3), result)
  assert.deepEqual(calls, [[7, 12, 'previous-epoch'], [0, 3, undefined]])
})

for (const action of ['disable', 'agent/disposed', 'unload']) {
  test(`${action} cleans both tools for two independent Agents despite throwing tools/change`, async t => {
    const { ctx, items, start, scoped, assertTools } = await lifecycle(t)
    const fiber = await start()
    const service = ctx.get('pluginLogs')
    for (const item of items) scoped(item).setToolEnabled(true)
    assertTools(true)
    const marker = new Error(`tools/change failed during ${action}`)
    const diagnostics = []
    const stopDiagnostics = ctx.logger.exporter({ export: message => diagnostics.push(...message.args) })
    t.after(stopDiagnostics)
    let notifications = 0
    const stopThrowing = ctx.on('tools/change', () => {
      notifications++
      if (action === 'unload') assert.equal(service.enabled.size, 0, 'all Map state must be detached before any disposer')
      throw marker
    })
    t.after(stopThrowing)
    if (action === 'unload') {
      await fiber.dispose()
      for (const item of items) {
        for (const name of [TOOL_NAME, SOURCES_TOOL_NAME]) {
          assert.ok(diagnostics.some(error => error instanceof Error && error.message.includes(name) && error.message.includes(item.value.id) && error.cause === marker), 'teardown errors must include Agent, tool and original cause')
        }
      }
    } else {
      for (const item of items) {
        assert.throws(() => action === 'disable'
          ? scoped(item).setToolEnabled(false)
          : ctx.emit('agent/disposed', { agent: item.value }), error => {
          assert.ok(error instanceof AggregateError)
          assert.equal(error.errors.length, 2)
          for (const detail of error.errors) {
            assert.equal(detail.cause, marker)
            assert.match(detail.message, new RegExp(item.value.id))
          }
          return true
        })
        assert.deepEqual(scoped(item).toolStatus(), { enabled: false })
      }
    }
    assert.equal(notifications, 4, 'every disposer must run, including later Agents')
    assert.equal(service.enabled.size, 0)
    assertTools(false)
    stopThrowing()
    if (action !== 'unload') await fiber.dispose()
    const reloaded = await start()
    for (const item of items) {
      assert.deepEqual(scoped(item).toolStatus(), { enabled: false })
      assert.deepEqual(scoped(item).setToolEnabled(true), { enabled: true })
    }
    assertTools(true)
    await reloaded.dispose()
    assertTools(false)
  })
}

test('registration failure rolls back both scoped tools even when rollback notifications throw', async t => {
  const { ctx, items, start, scoped, assertTools } = await lifecycle(t)
  await start()
  const marker = new Error('registration and rollback tools/change failure')
  for (const item of items) {
    let notifications = 0
    const stopThrowing = ctx.on('tools/change', () => {
      if (++notifications >= 2) throw marker
    })
    try {
      assert.throws(() => scoped(item).setToolEnabled(true), error => {
        assert.ok(error instanceof AggregateError)
        assert.match(error.message, /registration and rollback/)
        assert.equal(error.cause, marker)
        assert.equal(error.errors[0], marker)
        assert.equal(error.errors[1].cause, marker)
        assert.match(error.errors[1].message, new RegExp(`${TOOL_NAME}.*${item.value.id}`))
        return true
      })
      assert.equal(notifications, 4, 'failed sources registration and existing query must both be undone')
      assert.deepEqual(scoped(item).toolStatus(), { enabled: false })
      assertTools(false)
    } finally { stopThrowing() }
  }
  for (const item of items) assert.deepEqual(scoped(item).setToolEnabled(true), { enabled: true })
  assertTools(true)
})

test('log query bounds results and applies literal case-insensitive OR without regex', () => {
  const buffer = { capacity: 4, sequence: 3, rows: [
    { sequence: 1, source: 'Market', text: 'ERROR', level: 'error' },
    { sequence: 2, source: 'Other', text: 'ready', level: 'info' },
    { sequence: 3, source: 'Chatroom', text: 'timeout', level: 'warn' },
    null,
  ] }
  assert.deepEqual(queryLogs(buffer, { source: 'market|chatroom', text: 'error|TIMEOUT' }).entries.map(row => row.sequence), [3, 1])
  assert.equal(queryLogs(buffer, { text: '(a+)+$' }).entries.length, 0)
  assert.throws(() => queryLogs(buffer, { limit: 51 }), /Limit/)
  assert.throws(() => queryLogs(buffer, { source: 'x'.repeat(121) }), /120/)
})

test('source listing counts only retained logs and bounds distinct names', () => {
  const buffer = { capacity: 3, sequence: 5, rows: [
    { sequence: 4, source: 'worker', time: 40 },
    { sequence: 5, source: 'api', time: 50 },
    { sequence: 3, source: 'worker', time: 30 },
  ] }
  assert.deepEqual(listLogSources(buffer), { sources: [
    { source: 'api', count: 1, latestSequence: 5, latestTime: 50 },
    { source: 'worker', count: 2, latestSequence: 4, latestTime: 40 },
  ], totalSources: 2, truncated: false, newestSequence: 5 })
  assert.deepEqual(listLogSources({ capacity: 2, sequence: 0, rows: [null, null] }).sources, [])
  const many = { capacity: 202, sequence: 202, rows: Array.from({ length: 202 }, (_, i) => ({ sequence: i + 1, source: `logger-${i}` })) }
  const listed = listLogSources(many)
  assert.equal(listed.sources.length, 200)
  assert.equal(listed.totalSources, 202)
  assert.equal(listed.truncated, true)
  assert.equal(listed.sources[0].source, 'logger-201')
})

test('scoped Remote toggles only its exact live top-level Agent and disposes on unload/reload', async () => {
  const ctx = new Context()
  ctx.reflect.provide('systemPrompt', { tools: () => () => {} })
  const toolsFiber = ctx.plugin(ToolRuntime, { mode: 'native' })
  await toolsFiber.await()
  const agents = new Map()
  ctx.reflect.provide('agents', { get: id => agents.get(id) })
  const fiber = ctx.plugin(PluginLogs, {})
  await fiber.await()
  const owner = ctx.plugin({ name: 'test-agents', inject: ['agents', 'tools'], apply() {} })
  await owner.await()
  const first = agent(owner.ctx, 'main')
  const other = agent(owner.ctx, 'other')
  const child = agent(owner.ctx, 'child', { origin: 'subagent', parentSession: 'main' })
  for (const item of [first, other, child]) agents.set(item.value.id, item.value)
  const scoped = value => value.ctx.get('pluginLogs')
  assert.deepEqual(scoped(first.value).toolStatus(), { enabled: false })
  assert.deepEqual(scoped(first.value).setToolEnabled(true), { enabled: true })
  assert.equal(ctx.tools.get(TOOL_NAME, first.value)?.name, TOOL_NAME)
  assert.equal(ctx.tools.get(SOURCES_TOOL_NAME, first.value)?.name, SOURCES_TOOL_NAME)
  for (const name of [TOOL_NAME, SOURCES_TOOL_NAME]) {
    assert.equal(ctx.tools.get(name, other.value), undefined)
    assert.equal(ctx.tools.get(name, child.value), undefined)
  }
  assert.deepEqual(scoped(other.value).toolStatus(), { enabled: false })
  assert.deepEqual(await ctx.tools.get(TOOL_NAME, first.value).execute({ limit: 1 }, { agent: first.value }), { entries: [], newestSequence: 0 })
  assert.deepEqual(await ctx.tools.get(SOURCES_TOOL_NAME, first.value).execute({}, { agent: first.value }), { sources: [], totalSources: 0, truncated: false, newestSequence: 0 })
  assert.throws(() => scoped(child.value).setToolEnabled(true), /top-level/)
  const definition = ctx.tools.get(TOOL_NAME, first.value)
  await assert.rejects(async () => definition.execute({}, { agent: other.value }), /restricted/)
  await assert.rejects(async () => ctx.tools.get(SOURCES_TOOL_NAME, first.value).execute({}, { agent: other.value }), /restricted/)
  assert.deepEqual(scoped(first.value).setToolEnabled(false), { enabled: false })
  assert.equal(ctx.tools.get(TOOL_NAME, first.value), undefined)
  assert.equal(ctx.tools.get(SOURCES_TOOL_NAME, first.value), undefined)
  scoped(first.value).setToolEnabled(true)
  ctx.emit('agent/disposed', { agent: first.value })
  assert.equal(ctx.tools.get(TOOL_NAME, first.value), undefined)
  assert.equal(ctx.tools.get(SOURCES_TOOL_NAME, first.value), undefined)
  scoped(first.value).setToolEnabled(true)
  scoped(other.value).setToolEnabled(true)
  const oldService = ctx.get('pluginLogs')
  await fiber.dispose()
  assert.equal(oldService.enabled.size, 0)
  for (const item of [first, other]) {
    assert.notEqual(item.value.ctx.fiber.uid, null, 'Agent owner must survive plugin unload')
    for (const name of [TOOL_NAME, SOURCES_TOOL_NAME]) assert.equal(ctx.tools.get(name, item.value), undefined)
  }
  const reloaded = ctx.plugin(PluginLogs, {})
  await reloaded.await()
  for (const item of [first, other]) {
    assert.deepEqual(scoped(item.value).toolStatus(), { enabled: false })
    assert.deepEqual(scoped(item.value).setToolEnabled(true), { enabled: true })
    for (const name of [TOOL_NAME, SOURCES_TOOL_NAME]) assert.equal(ctx.tools.get(name, item.value)?.name, name)
  }
  await reloaded.dispose()
  for (const item of [first, other]) {
    for (const name of [TOOL_NAME, SOURCES_TOOL_NAME]) assert.equal(ctx.tools.get(name, item.value), undefined)
  }
  for (const item of [first, other, child]) await item.scope.dispose()
  await owner.dispose()
  await toolsFiber.dispose()
})
