import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { isLogLevel, type LogRecord, type LogEntry, type LogPage } from '../shared/types.js'

const LIMIT = 2000
const TEXT_LIMIT = 4096
const SOURCE_LIMIT = 160
const ARG_LIMIT = 32
const PROPERTY_LIMIT = 64
const DEPTH_LIMIT = 3
const ARRAY_LIMIT = 20
const MISSING = Symbol('missing data property')
// Arbitrary object-key enumeration (even an early-breaking for…in) can allocate
// every key first. Probe a fixed vocabulary instead; unknown fields are omitted.
const PREVIEW_KEYS = ['message', 'stack', 'name', 'code', 'cause', 'error', 'status', 'id', 'path', 'url', 'method', 'type', 'event', 'plugin', 'sessionId', 'agentId', 'duration', 'count', 'result', 'data', 'details', 'value', 'reason', 'ok']

function ownData(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || types.isProxy(value)) return MISSING
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : MISSING
  } catch { return MISSING }
}

// UTF-16 round-tripping really copies truncated strings, unlike slice/concat.
// It also preserves lone surrogates, unlike a default UTF-8 round-trip.
function detached(value: string, limit: number): string {
  return Buffer.from(value.slice(0, limit), 'utf16le').toString('utf16le')
}

function formatArgs(args: unknown): string {
  const output: string[] = []
  let remaining = TEXT_LIMIT
  let properties = PROPERTY_LIMIT
  const ancestors = new Set<unknown>()
  const append = (text: string): void => {
    if (!remaining) return
    const part = text.slice(0, remaining)
    output.push(part)
    remaining -= part.length
  }
  const property = (object: unknown, key: string): unknown => {
    if (!properties || !remaining) return MISSING
    properties--
    return ownData(object, key)
  }
  const write = (value: unknown, depth = 0, quoted = false): void => {
    if (!remaining) return
    if (value === MISSING) return append('[unavailable]')
    if (typeof value === 'string') {
      if (quoted) append('"')
      append(value)
      if (quoted) append('"')
      return
    }
    if (value === null) return append('null')
    switch (typeof value) {
      case 'undefined': return append('undefined')
      case 'number': case 'boolean': return append(String(value))
      // Converting an arbitrary BigInt to decimal can itself be unbounded.
      case 'bigint': return append(value >= -99999999999999999999n && value <= 99999999999999999999n ? `${value}n` : '[BigInt]')
      case 'symbol': return append('[Symbol]')
      case 'function': return append('[Function]')
    }
    if (types.isProxy(value)) return append('[Proxy]')
    if (ancestors.has(value)) return append('[Circular]')
    const array = Array.isArray(value)
    if (depth >= DEPTH_LIMIT || !properties) return append(array ? '[Array]' : '[Object]')
    ancestors.add(value)
    if (array) {
      // Non-proxy arrays have an own numeric length data property.
      const length = property(value, 'length') as number
      append('[')
      let index = 0
      for (; index < Math.min(length, ARRAY_LIMIT) && remaining && properties; index++) {
        if (index) append(', ')
        write(property(value, String(index)), depth + 1, true)
      }
      if (index < length) append(index ? ', …' : '…')
      append(']')
    } else {
      // Never request Error.stack: its lazy descriptor may run prepareStackTrace.
      const error = types.isNativeError(value)
      if (error) append('Error ')
      append('{ ')
      let count = 0
      for (const key of PREVIEW_KEYS) {
        if (!remaining || !properties) break
        if (error && key === 'stack') continue
        const field = property(value, key)
        if (field === MISSING) continue
        if (count++) append(', ')
        append(`${key}: `)
        write(field, depth + 1, true)
      }
      append(count ? ', … }' : '… }')
    }
    ancestors.delete(value)
  }
  if (!Array.isArray(args) || types.isProxy(args)) return '[unavailable arguments]'
  const length = ownData(args, 'length') as number
  const count = Math.min(length, ARG_LIMIT)
  let next = 0
  const take = () => ownData(args, String(next++))
  if (count) {
    const first = take()
    if (typeof first === 'string') {
      // Parse only as far as the output budget, never replace over a huge input.
      for (let index = 0; index < first.length && remaining; index++) {
        const char = first[index]
        const specifier = first[index + 1]
        if (char !== '%') { append(char); continue }
        if (specifier === '%') { append('%'); index++; continue }
        if (!specifier || !'sdifoOjcC'.includes(specifier) || next >= count) { append('%'); continue }
        index++
        const value = take()
        if (specifier === 'c') continue
        if ('dif'.includes(specifier)) {
          if (value !== MISSING && (value === null || ['number', 'boolean', 'undefined'].includes(typeof value) || (typeof value === 'string' && value.length <= 128))) {
            const numeric = Number(value)
            append(String(specifier === 'f' ? numeric : Math.trunc(numeric)))
          } else append('[non-numeric]')
        } else write(value)
      }
    } else write(first)
  }
  while (next < count && remaining) { append(' '); if (remaining) write(take()) }
  if (length > ARG_LIMIT && remaining) append(' …')
  return detached(output.join(''), TEXT_LIMIT)
}

// Only detached primitives survive; no Fiber, arguments, getters, user coercion,
// customInspect/toJSON, or ownKeys calls. Work: <=32 argument reads, <=64 preview
// property probes, depth <=3, text <=4096 + source <=160 UTF-16 code units.
export function normalize(message: unknown): LogRecord {
  try {
    const ts = ownData(message, 'ts')
    const name = ownData(message, 'name')
    const type = ownData(message, 'type')
    return {
      time: typeof ts === 'number' && Number.isFinite(ts) && Math.abs(ts) <= 8640000000000000 ? ts : Date.now(),
      source: typeof name === 'string' ? detached(name, SOURCE_LIMIT) : 'unknown',
      level: isLogLevel(type) ? type : 'info',
      text: formatArgs(ownData(message, 'args')),
    }
  } catch { return { time: Date.now(), source: 'unknown', level: 'error', text: '[log formatting failed]' } }
}

export class LogBuffer {
  readonly capacity: number
  readonly rows: (LogEntry | undefined)[]
  sequence: number
  readonly epoch: string
  constructor(capacity = LIMIT) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) throw new RangeError('Invalid capacity')
    this.capacity = capacity
    this.rows = new Array(capacity)
    this.sequence = 0
    this.epoch = randomUUID()
  }
  push(record: LogRecord): void {
    const sequence = ++this.sequence
    this.rows[(sequence - 1) % this.capacity] = { sequence, ...record }
  }
  tail(cursor = 0, limit = 200, epoch?: string): LogPage {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('Invalid log page request')
    const newest = this.sequence
    const earliest = Math.max(1, newest - this.capacity + 1)
    const reset = (epoch !== undefined && epoch !== '' && epoch !== this.epoch) || cursor > newest
    // A reset is not an overwrite gap: its old cursor belongs to another window.
    const effectiveCursor = reset ? earliest - 1 : cursor
    const start = Math.max(earliest, effectiveCursor + 1)
    const end = Math.min(newest, start + limit - 1)
    const entries: LogEntry[] = []
    for (let seq = start; seq <= end; seq++) entries.push(this.rows[(seq - 1) % this.capacity]!) // Every sequence in the retained window has been written.
    return { entries, cursor: entries.at(-1)?.sequence ?? effectiveCursor, dropped: reset ? 0 : Math.max(0, earliest - 1 - cursor), epoch: this.epoch, reset }
  }
}
