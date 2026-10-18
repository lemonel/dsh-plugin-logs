import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { LogPage, ToolStatus } from '../shared/types.js'
import type { PluginLogsConfig } from './types.js'
import { TypertRemoteService, Remote, RemoteScope } from '@deepseek-ai/dsh-typert-protocol'
import { LogBuffer, normalize } from './core.js'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { logQueryTool, logSourcesTool } from './query.js'

interface EnabledEntry { agent: Agent; disposers: [string, () => void][] }

export class PluginLogs extends TypertRemoteService {
  static inject = ['agents', 'tools']
  readonly records: LogBuffer
  private readonly owner: Context
  private readonly enabled: Map<SessionId, EnabledEntry>
  constructor(ctx: Context, config: PluginLogsConfig = {}) {
    super(ctx, 'pluginLogs', { namespace: 'pluginLogs' })
    this.records = new LogBuffer(config.capacity ?? 2000)
    this.owner = ctx
    this.enabled = new Map()
    ctx.on('agent/disposed', ({ agent }) => {
      const entry = this.enabled.get(agent.id)
      if (entry?.agent === agent) this.disposeEntries([entry])
    })
    ctx.effect(() => () => {
      this.disposeEntries([...this.enabled.values()])
    }, 'plugin-logs: scoped tools')
    // Cordis invokes exporters synchronously; the callback must never throw.
    ctx.logger.exporter({ levels: { default: 3 }, export: message => {
      try { this.records.push(normalize(message)) } catch { /* logging must not break its caller */ }
    } })
  }
  @Remote
  tail(cursor: number, limit: number, epoch?: string): LogPage { return this.records.tail(cursor, limit, epoch) }
  disposeEntries(entries: EnabledEntry[]): void {
    // Detach ownership before notifying observers: a throwing tools/change
    // listener must not leave stale status or block another Agent's cleanup.
    for (const entry of entries) {
      if (this.enabled.get(entry.agent.id) === entry) this.enabled.delete(entry.agent.id)
    }
    const errors: Error[] = []
    for (const { agent, disposers } of entries) {
      for (const [name, dispose] of [...disposers].reverse()) {
        try { dispose() }
        catch (cause) { errors.push(new Error(`Failed to dispose ${name} for Agent ${agent.id}`, { cause })) }
      }
    }
    // RPC callers receive the diagnostics; Cordis logs effect teardown errors.
    if (errors.length) throw new AggregateError(errors, 'PluginLogs tool cleanup failed')
  }
  // The gateway resolves the *live* Agent context from the scoped RPC identity.
  // A root/direct RPC has no scope and cannot enable a tool for an arbitrary id.
  private currentAgent(): Agent {
    const key = scopeOf(this.ctx)
    // scopeOf deliberately exposes only an opaque object. Resolve through the
    // registry and compare identity before treating that key as a live Agent.
    const agent = key && 'id' in key && typeof key.id === 'string'
      ? this.owner.agents.get(key.id as SessionId) : undefined
    if (!agent || agent !== key || agent.session?.id !== agent.id || agent.session.header?.origin === 'subagent' || agent.session.header?.parentSession !== undefined) throw new Error('A live top-level Session Agent is required')
    return agent
  }
  @RemoteScope('agent')
  toolStatus(): ToolStatus {
    const agent = this.currentAgent()
    return { enabled: this.enabled.get(agent.id)?.agent === agent }
  }
  @RemoteScope('agent')
  setToolEnabled(enabled: boolean): ToolStatus {
    const agent = this.currentAgent()
    if (typeof enabled !== 'boolean') throw new Error('Invalid tool state')
    const previous = this.enabled.get(agent.id)
    if (previous && previous.agent !== agent) this.disposeEntries([previous])
    if (!enabled) {
      if (previous?.agent === agent) this.disposeEntries([previous])
    } else if (!this.enabled.has(agent.id)) {
      const entry: EnabledEntry = { agent, disposers: [] }
      try {
        for (const tool of [logQueryTool(this.records, agent), logSourcesTool(this.records, agent)]) {
          entry.disposers.push([tool.name, agent.ctx.tools.register(tool)])
        }
      } catch (error) {
        try { this.disposeEntries([entry]) }
        catch (cleanupError) {
          throw new AggregateError([error, ...(cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError])], `PluginLogs tool registration and rollback failed for Agent ${agent.id}`, { cause: error })
        }
        throw error
      }
      this.enabled.set(agent.id, entry)
    }
    return { enabled: this.enabled.has(agent.id) }
  }
}
