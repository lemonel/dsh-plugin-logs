import type { InvocationDescriptor, TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { isLogLevel, type LogEntry, type LogPage, type ToolStatus } from './types.js'
export type * from './types.js'

export const PACKAGE = '@lemonel/dsh-plugin-logs'
const EPOCH_LIMIT = 100
const codec = <T>(name: string, parse: (value: unknown) => T): Extract<TypertCodec, { mode: 'strict' }> => ({ mode: 'strict', typeSymbol: `${PACKAGE}#${name}`, create: () => ({ parse }) })
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' }
function nonnegativeInteger(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function validEntry(value: unknown): value is LogEntry {
  return object(value) && nonnegativeInteger(value.sequence) && value.sequence >= 1
    && typeof value.time === 'number' && Number.isFinite(value.time) && Math.abs(value.time) <= 8640000000000000
    && typeof value.source === 'string' && value.source.length <= 160
    && typeof value.text === 'string' && value.text.length <= 4096 && isLogLevel(value.level)
}
export function parseLogPage(value: unknown): LogPage {
  if (!object(value) || !Array.isArray(value.entries) || value.entries.length > 500
    || !nonnegativeInteger(value.cursor) || !nonnegativeInteger(value.dropped)
    || typeof value.epoch !== 'string' || !value.epoch.length || value.epoch.length > EPOCH_LIMIT || typeof value.reset !== 'boolean') throw new Error('Invalid log page')
  let previousSequence: number | undefined
  for (const row of value.entries) {
    if (!validEntry(row)) throw new Error('Invalid log entry')
    if (previousSequence !== undefined && row.sequence - previousSequence !== 1) throw new Error('Invalid log page')
    previousSequence = row.sequence
  }
  if ((previousSequence !== undefined && value.cursor !== previousSequence)
    || (value.reset && value.dropped !== 0)
    || (!value.entries.length && (value.dropped !== 0 || (value.reset && value.cursor !== 0)))) throw new Error('Invalid log page')
  // Fields, nested entries and page relationships are valid; preserve the original value.
  return value as LogPage & Record<string, unknown>
}
export function parseToolStatus(value: unknown): ToolStatus {
  if (!object(value) || typeof value.enabled !== 'boolean') throw new Error('Invalid tool status')
  return value as ToolStatus & Record<string, unknown>
}
const cursor = codec('cursor', value => { if (!nonnegativeInteger(value)) throw new Error('Invalid cursor'); return value })
const limit = codec('limit', value => { if (!nonnegativeInteger(value) || value < 1 || value > 500) throw new Error('Invalid limit'); return value })
const epoch = codec('epoch', value => { if (value === undefined || value === '') return ''; if (typeof value !== 'string' || value.length > EPOCH_LIMIT) throw new Error('Invalid epoch'); return value })
const result = codec('page', parseLogPage)
const agentId: TypertCodec = { ...codec('agentId', value => { if (typeof value !== 'string' || !value.length) throw new Error('Invalid Agent id'); return value }), typeSymbol: '@deepseek-ai/dsh-session/types#SessionId' }
const bool = codec('enabled', value => { if (typeof value !== 'boolean') throw new Error('Invalid tool state'); return value })
const status = codec('status', parseToolStatus)
const scoped = { kind: 'context', context: 'agent', wire: 'agentId', codec: agentId } as const
export const descriptors: InvocationDescriptor[] = [
  { id: `${PACKAGE}#pluginLogs/tail`, service: 'pluginLogs', namespace: 'pluginLogs', method: 'tail', invocation: { kind: 'direct' }, parameters: [{ name: 'cursor', wire: 'cursor', source: 'json', codec: cursor }, { name: 'limit', wire: 'limit', source: 'json', codec: limit }, { name: 'epoch', wire: 'epoch', source: 'json', codec: epoch }], result },
  { id: `${PACKAGE}#pluginLogs/toolStatus`, service: 'pluginLogs', namespace: 'pluginLogs', method: 'toolStatus', invocation: scoped, parameters: [], result: status },
  { id: `${PACKAGE}#pluginLogs/setToolEnabled`, service: 'pluginLogs', namespace: 'pluginLogs', method: 'setToolEnabled', invocation: scoped, parameters: [{ name: 'enabled', wire: 'enabled', source: 'json', codec: bool }], result: status },
]
export const remote = { package: PACKAGE, descriptors }
