import { useState, useEffect, useRef, useMemo } from 'react'
import { createRegexRunner, createTailPoller } from './client-runtime.js'
import type { RegexResult } from './client-runtime.js'
import { observeTools } from './tool-state.js'
import type { ToolState, ToolController } from './tool-state.js'
import { errorMessage } from './client-compat.js'
import type { PanelProps } from './client-compat.js'
import type { LogEntry } from '../shared/types.js'
import { sourceOptions } from './display.js'

// Keep interaction rules and request lifetimes together; Panel only renders them.
export function usePanelState({ service, sessions, sessionId, useSession, t }: PanelProps) {
  const subagent = useSession(snapshot => snapshot.subagent)
  const [tool, setTool] = useState<ToolState>({ enabled: false, ready: false, busy: false, error: null })
  const toolController = useRef<ToolController | null>(null)
  useEffect(() => {
    setTool({ enabled: false, ready: false, busy: false, error: null })
    if (!sessionId || subagent) return
    const controller = observeTools(sessions, sessionId, setTool)
    toolController.current = controller
    return () => { toolController.current = null; controller.dispose() }
  }, [sessions, sessionId, subagent, service])
  const toggleTool = () => toolController.current?.toggle()
  const [rows, setRows] = useState<LogEntry[]>([])
  const [source, setSource] = useState('')
  const [level, setLevel] = useState('')
  const [queries, setQueries] = useState([''])
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState('')
  const [dropped, setDropped] = useState(0)
  const poller = useRef<ReturnType<typeof createTailPoller> | null>(null)
  useEffect(() => {
    const controller = createTailPoller(service, {
      onPage(page) {
        if (page.reset) setDropped(page.dropped)
        else if (page.dropped) setDropped(value => value + page.dropped)
        if (page.reset || page.entries.length) setRows(value => [...(page.reset ? [] : value), ...page.entries].slice(-2000))
        setError('')
      },
      onError(cause) { setError(errorMessage(cause)) },
    })
    poller.current = controller
    return () => { poller.current = null; controller.dispose() }
  }, [service])
  useEffect(() => { poller.current?.setPaused(paused) }, [service, paused])
  const latestRows = useRef(rows)
  latestRows.current = rows
  const [matches, setMatches] = useState<RegexResult<LogEntry> & { input: LogEntry[] | null; source?: string; level?: string; queries?: string[] }>({ input: null, rows: [], error: null })
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let previous: LogEntry[] | undefined
    const runner = createRegexRunner()
    const run = async () => {
      const input = latestRows.current
      if (input !== previous) {
        previous = input
        // New log pages do not cancel an in-flight search (or its time budget).
        const result = await runner.run(input, source, level, queries)
        if (!active) return
        setMatches({ ...result, input, source, level, queries })
      }
      if (active) timer = setTimeout(run, 120)
    }
    timer = setTimeout(run, queries.some(Boolean) ? 120 : 0)
    return () => { active = false; clearTimeout(timer); runner.dispose() }
  }, [source, level, queries])
  const sources = useMemo(() => sourceOptions(rows, source), [rows, source])
  const retained = useMemo(() => new Set(rows), [rows])
  const currentMatches = matches.source === source && matches.level === level && matches.queries === queries
  const filtered = currentMatches ? matches.rows.filter(row => retained.has(row)) : []
  const filterError = currentMatches && matches.error ? t(matches.error.key, matches.error.values) : ''
  const togglePaused = () => setPaused(value => !value)
  const clearRows = () => { setRows([]); setSource(''); setDropped(0) }
  const updateQuery = (index: number, query: string) => setQueries(values => values.map((value, i) => i === index ? query : value))
  const removeQuery = (index: number) => setQueries(values => values.filter((_, i) => i !== index))
  const addQuery = () => setQueries(values => values.length < 8 ? [...values, ''] : values)
  return {
    subagent, tool, toggleTool, source, setSource, level, setLevel, queries,
    paused, togglePaused, clearRows, updateQuery, removeQuery, addQuery,
    error, dropped, sources, filtered, filterError, currentMatches,
  }
}
