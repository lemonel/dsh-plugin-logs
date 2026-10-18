import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LogBuffer } from './core.js'
import { isLogLevel, type LogEntry } from '../shared/types.js'
import type { LogQueryArgs, LogQueryResult, LogSource, LogSourcesResult } from './types.js'

export const TOOL_NAME = 'plugin_logs_query'
export const SOURCES_TOOL_NAME = 'plugin_logs_sources'
const MAX_ROWS = 50
const MAX_SOURCES = 200
const MAX_PATTERN = 120

// Deliberately use literal case-insensitive substrings: model-provided regex can
// catastrophically backtrack on log text. A | separates alternative substrings.
function alternatives(value: unknown): string[] {
  if (value === undefined || value === '') return []
  if (typeof value !== 'string' || value.length > MAX_PATTERN) throw new Error('Filter must be a string of at most 120 characters')
  return value.toLowerCase().split('|').map(part => part.trim()).filter(Boolean)
}
export function queryLogs(buffer: LogBuffer, args: LogQueryArgs = {}): LogQueryResult {
  const source = alternatives(args.source)
  const text = alternatives(args.text)
  if (args.level !== undefined && !isLogLevel(args.level)) throw new Error('Invalid log level')
  const limit = args.limit === undefined ? 20 : args.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) throw new Error('Limit must be between 1 and 50')
  const match = (value: string, terms: string[]) => !terms.length || terms.some(term => value.toLowerCase().includes(term))
  const rows: LogEntry[] = []
  const earliest = Math.max(1, buffer.sequence - buffer.capacity + 1)
  for (let seq = buffer.sequence; seq >= earliest && rows.length < limit; seq--) {
    const row = buffer.rows[(seq - 1) % buffer.capacity]
    if (row && match(row.source, source) && match(`${row.source} ${row.text}`, text) && (args.level === undefined || row.level === args.level)) rows.push(row)
  }
  return { entries: rows, newestSequence: buffer.sequence }
}
// These are logger names observed in the retained Host buffer, not a plugin inventory.
export function listLogSources(buffer: LogBuffer): LogSourcesResult {
  const found = new Map<string, LogSource>()
  const earliest = Math.max(1, buffer.sequence - buffer.capacity + 1)
  for (let seq = buffer.sequence; seq >= earliest; seq--) {
    const row = buffer.rows[(seq - 1) % buffer.capacity]
    if (!row || row.sequence !== seq) continue
    const previous = found.get(row.source)
    if (previous) previous.count++
    else found.set(row.source, { source: row.source, count: 1, latestSequence: seq, latestTime: row.time ?? null })
  }
  const sources = [...found.values()].sort((a, b) => b.latestSequence - a.latestSequence)
  return { sources: sources.slice(0, MAX_SOURCES), totalSources: sources.length, truncated: sources.length > MAX_SOURCES, newestSequence: buffer.sequence }
}
export function logSourcesTool(buffer: LogBuffer, authorizedAgent: Agent) {
  return defineTool({
    name: SOURCES_TOOL_NAME,
    description: 'List distinct Cordis logger source names observed in the retained Host log buffer, newest first. These names are not guaranteed to correspond to installed plugins; silent plugins and expired logs are absent. Returns up to 200 sources with retained log counts.',
    parameters: {},
    output: { schema: { type: 'object', properties: { sources: { type: 'array', items: { type: 'object', additionalProperties: true } }, totalSources: { type: 'number' }, truncated: { type: 'boolean' }, newestSequence: { type: 'number' } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      if (exec.agent !== authorizedAgent) throw new Error('Log sources are restricted to the selected live Agent')
      return listLogSources(buffer)
    },
  })
}
export function logQueryTool(buffer: LogBuffer, authorizedAgent: Agent) {
  return defineTool({
    name: TOOL_NAME,
    description: 'Query recent Host Cordis logger messages captured in memory. This is Host-wide logging, not a plugin inventory or Session history. Use plugin_logs_sources to discover observed logger names. source and text support literal case-insensitive alternatives separated by |; results are newest first.',
    parameters: { source: { type: 'string' }, text: { type: 'string' }, level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] }, limit: { type: 'integer' } },
    output: { schema: { type: 'object', properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: true } }, newestSequence: { type: 'number' } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (exec.agent !== authorizedAgent) throw new Error('Log query is restricted to the selected live Agent')
      return queryLogs(buffer, args)
    },
  })
}
