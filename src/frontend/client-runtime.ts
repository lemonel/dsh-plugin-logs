import { parseLogPage } from '../shared/contract.js'
import { isRecord } from './client-compat.js'
import type { TailService } from './client-compat.js'
import type { LogPage } from '../shared/types.js'

export interface RegexError { key: string; values: Record<string, unknown> }
export interface RegexResult<T> { rows: T[]; error: RegexError | null }
interface WorkerScope { onmessage: ((event: { data: unknown }) => void) | null; postMessage(value: unknown): void }
// Only referenced when this kernel is serialized into an actual Worker.
declare const self: WorkerScope
interface SearchWorker {
  postMessage(value: unknown): void
  terminate(): unknown
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror?: ((event: MessageEvent<unknown>) => void) | null
}
interface RegexOptions { timeoutMs?: number; workerFactory?: (main: typeof workerMain) => SearchWorker | null }
interface Task<T> { resolve: (result: RegexResult<T>) => void; worker: SearchWorker | null; url: string | null; timer: ReturnType<typeof setTimeout> | undefined; cancel(): void }
function field(row: unknown, name: string): unknown { return isRecord(row) ? row[name] : undefined }


// This function must remain self-contained: its source is installed in a dedicated
// Worker, never invoked by the GUI thread. The optional scope supports Node tests.
export function workerMain(scope: WorkerScope = self) {
  scope.onmessage = ({ data }) => {
    // This validation is deliberately local: workerMain is serialized in isolation.
    const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
    if (!object(data) || !Array.isArray(data.queries) || !Array.isArray(data.rows)) {
      scope.postMessage({ indices: [], error: { key: 'regexUnavailable', values: {} } }); return
    }
    const patterns: RegExp[] = []
    for (const query of data.queries) {
      if (!object(query) || typeof query.value !== 'string' || typeof query.n !== 'number') { scope.postMessage({ indices: [], error: { key: 'regexUnavailable', values: {} } }); return }
      try { patterns.push(new RegExp(query.value, 'i')) }
      catch (error) {
        scope.postMessage({ indices: [], error: { key: 'regexInvalid', values: { n: query.n, error: String(object(error) && error.message ? error.message : error) } } })
        return
      }
    }
    const indices = []
    for (let index = 0; index < data.rows.length; index++) {
      const value: unknown = data.rows[index]
      const row = object(value) ? value : {}
      const text = `${row.source ?? ''} ${row.text ?? ''}`
      if (patterns.some(pattern => pattern.test(text))) indices.push(index)
    }
    scope.postMessage({ indices, error: null })
  }
}


export function createRegexRunner(options: RegexOptions = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs ?? 500) : 500
  let active: { cancel(): void } | null = null
  let disposed = false
  let lastSignature: string | null = null
  let blockedSignature: string | null = null
  const empty = <T>(): RegexResult<T> => ({ rows: [], error: null })
  const failure = <T>(key: string, values: Record<string, unknown> = {}): RegexResult<T> => ({ rows: [], error: { key, values } })

  function finish<T>(task: Task<T>, result: RegexResult<T>) {
    if (active !== task) return
    active = null
    clearTimeout(task.timer)
    if (task.worker) {
      try { task.worker.onmessage = task.worker.onerror = task.worker.onmessageerror = null } catch {}
      try { task.worker.terminate() } catch {}
    }
    if (task.url !== null) {
      try { URL.revokeObjectURL(task.url) } catch {}
    }
    task.resolve(result)
  }
  function cancel() {
    active?.cancel()
  }

  function run<T>(rows: readonly T[] | null | undefined, source: string, level: string, queries: unknown): Promise<RegexResult<T>> {
    cancel()
    if (disposed) return Promise.resolve(empty())
    const input: unknown[] = Array.isArray(queries) ? queries : [queries]
    // Preserve positions for translated error labels, including empty conditions.
    const signature = JSON.stringify(input.map(value => value == null ? '' : typeof value === 'string' ? value : [typeof value, String(value)]))
    if (signature !== lastSignature) blockedSignature = null
    lastSignature = signature
    const conditions: { value: string; n: number }[] = []
    for (let index = 0; index < input.length; index++) {
      const value = input[index]
      if (value == null || value === '') continue
      if (typeof value !== 'string') return Promise.resolve(failure('regexInvalid', { n: index + 1, error: 'Regex must be a string' }))
      if (value.length > 200) return Promise.resolve(failure('regexTooLong', { n: index + 1 }))
      conditions.push({ value, n: index + 1 })
    }
    if (conditions.length && input.length > 8) return Promise.resolve(failure('regexTooMany'))
    const candidates: readonly T[] = Array.isArray(rows) ? rows : []
    const selected = candidates.filter(row => (!source || field(row, 'source') === source) && (!level || field(row, 'level') === level))
    if (!conditions.length) return Promise.resolve({ rows: selected, error: null })
    if (blockedSignature === signature) return Promise.resolve(failure('regexTimeout'))

    return new Promise<RegexResult<T>>(resolve => {
      const task: Task<T> = { resolve, worker: null, url: null, timer: undefined, cancel: () => finish(task, empty<T>()) }
      active = task
      try {
        if (options.workerFactory) {
          // A factory returns { postMessage, onmessage, onerror, terminate }.
          // It may serialize workerMain into a node:worker_threads adapter.
          task.worker = options.workerFactory(workerMain)
        } else {
          if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL?.createObjectURL !== 'function') throw new Error('Worker unavailable')
          task.url = URL.createObjectURL(new Blob([`(${workerMain.toString()})();`], { type: 'text/javascript' }))
          task.worker = new Worker(task.url)
        }
        const worker = task.worker
        if (!worker || typeof worker.postMessage !== 'function' || typeof worker.terminate !== 'function') throw new Error('Worker unavailable')
        worker.onmessage = event => {
          if (active !== task) return
          const result = event.data
          if (!isRecord(result)) { finish(task, failure('regexUnavailable')); return }
          if (isRecord(result.error) && result.error.key === 'regexInvalid') {
            if (!isRecord(result.error.values) || typeof result.error.values.n !== 'number' || typeof result.error.values.error !== 'string') { finish(task, failure('regexUnavailable')); return }
            finish(task, { rows: [], error: { key: 'regexInvalid', values: result.error.values } })
          } else if (result.error || !Array.isArray(result.indices) || !result.indices.every((index: unknown): index is number => typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < selected.length)) {
            finish(task, failure('regexUnavailable'))
          } else {
            finish(task, { rows: result.indices.map(index => selected[index]), error: null })
          }
        }

        worker.onerror = worker.onmessageerror = () => finish(task, failure('regexUnavailable'))
        task.timer = setTimeout(() => {
          if (active !== task) return
          blockedSignature = signature
          finish(task, failure('regexTimeout'))
        }, timeoutMs)
        // Copy only searchable strings; never clone the caller's original rows.
        worker.postMessage({ rows: selected.map(row => ({ source: String(field(row, 'source') ?? ''), text: String(field(row, 'text') ?? '') })), queries: conditions })
      } catch {
        finish(task, failure('regexUnavailable'))
      }
    })
  }

  return { run, cancel, dispose() { disposed = true; cancel() } }
}


export function createTailPoller(service: TailService, options: {
  onPage?: (page: LogPage) => void; onError?: (error: unknown) => void
  intervalMs?: number; yieldMs?: number; maxBurst?: number
  setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void
} = {}) {
  const { onPage = () => {}, onError = () => {}, intervalMs = 1200, yieldMs = 16, maxBurst = 4 } = options
  const setTimer = options.setTimeout || setTimeout
  const clearTimer = options.clearTimeout || clearTimeout
  const burstLimit = Number.isFinite(maxBurst) ? Math.max(1, Math.floor(maxBurst)) : 4
  let paused = true
  let disposed = false
  let inflight = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let cursor = 0
  let epoch = ''
  let burst = 0

  function clearScheduled() {
    if (timer !== null) clearTimer(timer)
    timer = null
  }
  function schedule(delay: number) {
    if (paused || disposed || inflight) return
    clearScheduled()
    timer = setTimer(() => { timer = null; void poll() }, delay)
  }
  async function poll() {
    if (disposed || paused || inflight) return
    clearScheduled()
    inflight = true
    let full = false
    try {
      const result = await service.tail(cursor, 300, epoch)
      if (disposed || paused) return
      if (isRecord(result) && result.ok === false) throw new Error(isRecord(result.error) && typeof result.error.message === 'string' ? result.error.message : 'Could not read plugin logs')
      const value = isRecord(result) && result.ok === true ? result.value : result
      let page: LogPage
      try { page = parseLogPage(value) } catch { throw new Error('Invalid plugin logs page') }
      if (page.reset) {
        // A same-epoch reset only corrects a future cursor; new epochs may start anywhere.
        if (!epoch || (page.epoch === epoch && page.cursor >= cursor)) throw new Error('Invalid plugin logs page')
      } else {
        const first = page.entries[0]
        // Continue this request exactly, accounting for overwritten rows before the page.
        if ((epoch !== '' && page.epoch !== epoch)
          || (first ? first.sequence - cursor - 1 !== page.dropped : page.cursor !== cursor)) throw new Error('Invalid plugin logs page')
      }
      cursor = page.cursor
      epoch = page.epoch
      full = page.entries.length >= 300
      onPage(page)
    } catch (error) {
      if (!disposed && !paused) {
        try { onError(error) } catch {}
      }
      full = false
    } finally {
      inflight = false
      if (!disposed && !paused) {
        if (full) {
          burst++
          if (burst < burstLimit) void poll()
          else { burst = 0; schedule(yieldMs) }
        } else {
          burst = 0
          schedule(intervalMs)
        }
      }
    }
  }

  return {
    setPaused(value: unknown) {
      if (disposed) return
      const next = !!value
      if (next === paused) return
      paused = next
      burst = 0
      clearScheduled()
      // Remote calls have no cancellation API. Keep their slot across pause and
      // resume, discarding a response only if still paused when it arrives.
      if (!paused && !inflight) void poll()
    },
    dispose() { disposed = true; paused = true; clearScheduled() },
  }
}
