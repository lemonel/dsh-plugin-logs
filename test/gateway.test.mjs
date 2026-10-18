import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import Registry from '@deepseek-ai/dsh-typert-registry'
import Gateway from '@deepseek-ai/dsh-api-gateway'
import { PluginLogs } from '../lib/backend/host.js'
import { TYPERT } from '../lib/typert.host.mjs'
import { TOOL_NAME, SOURCES_TOOL_NAME } from '../lib/backend/query.js'

test('real registry and Gateway dispatch direct tail and scoped live-Agent tool controls', async t => {
  const ctx = new Context()
  const fibers = []
  const scopes = []
  t.after(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    for (const scope of scopes) await scope.dispose()
  })
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config)
    fibers.push(fiber)
    await fiber.await()
    return fiber
  }
  ctx.reflect.provide('systemPrompt', { tools: () => () => {} })
  ctx.reflect.provide('remoteAccess', { decide: () => ({ kind: 'allow' }) })
  const agents = new Map()
  ctx.reflect.provide('agents', { get: id => agents.get(id) })
  await mount(ToolRuntime, { mode: 'native' })
  await mount(Registry)
  ctx.typert.register(TYPERT)
  await mount(PluginLogs, { capacity: 3 })
  const owner = await mount({ name: 'gateway-test-agents', inject: ['tools'], apply() {} })
  const makeAgent = (id, header = {}) => {
    const agent = { id, session: { id, header } }
    const scope = createScope(owner.ctx, agent)
    scopes.push(scope)
    agent.ctx = scope.ctx
    agents.set(id, agent)
    return agent
  }
  const first = makeAgent('first')
  const second = makeAgent('second')
  const child = makeAgent('child', { origin: 'subagent' })
  ctx.typert.contexts.registerHost('agent', {
    wire: 'agentId', wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
    resolve: id => agents.get(id)?.ctx,
  })
  await mount(Gateway, {})
  assert.ok(ctx.typertGateway, 'gateway must mount; this test must not silently skip real dispatch')
  const peer = { signal: new AbortController().signal, principal: { kind: 'owner' } }
  const invoke = (method, args) => ctx.typertGateway.invoke({ namespace: 'pluginLogs', method, args, peer })
  const service = ctx.get('pluginLogs')
  service.records.push({ time: 123, source: 'gateway-test', text: 'hello', level: 'info' })
  const page = await invoke('tail', { cursor: 0, limit: 10, epoch: '' })
  assert.equal(page.entries.at(-1).text, 'hello')
  assert.equal(page.epoch, service.records.epoch)
  assert.deepEqual(await invoke('toolStatus', { agentId: first.id }), { enabled: false })
  assert.deepEqual(await invoke('setToolEnabled', { agentId: first.id, enabled: true }), { enabled: true })
  assert.deepEqual(await invoke('toolStatus', { agentId: second.id }), { enabled: false })
  for (const name of [TOOL_NAME, SOURCES_TOOL_NAME]) {
    assert.equal(ctx.tools.get(name, first)?.name, name)
    assert.equal(ctx.tools.get(name, second), undefined)
  }
  await assert.rejects(invoke('setToolEnabled', { agentId: child.id, enabled: true }), /top-level/)
  await assert.rejects(invoke('toolStatus', { agentId: 'missing' }))
  await assert.rejects(invoke('setToolEnabled', { agentId: first.id, enabled: 'true' }))
  await assert.rejects(invoke('toolStatus', {}))
  await assert.rejects(invoke('tail', { cursor: -1, limit: 10, epoch: '' }))
  await assert.rejects(invoke('tail', { cursor: 0, limit: 501, epoch: '' }))
  assert.deepEqual(await invoke('setToolEnabled', { agentId: first.id, enabled: false }), { enabled: false })
  assert.equal(ctx.tools.get(TOOL_NAME, first), undefined)
})
