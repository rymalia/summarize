type ExtensionLogLevel = 'info' | 'warn' | 'error' | 'verbose'

type ExtensionLogEvent = {
  event: string
  level?: ExtensionLogLevel
  detail?: Record<string, unknown>
  scope?: string
}

type ExtensionLogResult = {
  ok: boolean
  lines: string[]
  truncated: boolean
  sizeBytes: number
  mtimeMs: number | null
}

const LOG_KEY = 'summarize:extension-logs'
const MAX_LOG_LINES = 4000
const MAX_LINE_LENGTH = 4000
const FLUSH_DELAY_MS = 250
const FLUSH_BATCH = 50

let flushTimer = 0
let flushInFlight = false
let pendingLines: string[] = []

const getStorage = () => chrome.storage?.session ?? chrome.storage?.local

const clampString = (value: string, limit = 300) => {
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

const normalizeDetailValue = (value: unknown): string | number | boolean | string[] | null => {
  if (value == null) return null
  if (typeof value === 'string') return clampString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return clampString(value.message)
  if (Array.isArray(value)) {
    const preview = value.slice(0, 6).map((item) => {
      if (typeof item === 'string') return clampString(item, 120)
      if (typeof item === 'number' || typeof item === 'boolean') return String(item)
      if (item instanceof Error) return clampString(item.message, 120)
      try {
        return clampString(JSON.stringify(item), 120)
      } catch {
        return String(item)
      }
    })
    return preview
  }
  if (typeof value === 'object') {
    try {
      return clampString(JSON.stringify(value), 300)
    } catch {
      return clampString(String(value))
    }
  }
  return clampString(String(value))
}

const normalizeDetails = (detail?: Record<string, unknown>) => {
  if (!detail) return {}
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(detail)) {
    const normalizedValue = normalizeDetailValue(value)
    if (normalizedValue == null) continue
    normalized[key] = normalizedValue
  }
  return normalized
}

const buildLogLine = (event: ExtensionLogEvent) => {
  const level = event.level ?? 'info'
  const details = normalizeDetails(event.detail)
  const entry = {
    date: new Date().toISOString(),
    logLevelName: level,
    event: event.event,
    ...(event.scope ? { scope: event.scope } : {}),
    ...details,
  }
  let line = JSON.stringify(entry)
  if (line.length > MAX_LINE_LENGTH) {
    line = JSON.stringify({
      date: entry.date,
      logLevelName: level,
      event: event.event,
      ...(event.scope ? { scope: event.scope } : {}),
      detail: 'truncated',
    })
  }
  return line
}

const queueFlush = () => {
  if (flushTimer) return
  flushTimer = globalThis.setTimeout(() => {
    flushTimer = 0
    void flushPending()
  }, FLUSH_DELAY_MS)
}

const flushPending = async () => {
  if (flushInFlight) return
  if (pendingLines.length === 0) return
  const store = getStorage()
  if (!store) {
    pendingLines = []
    return
  }
  flushInFlight = true
  try {
    const res = await store.get(LOG_KEY)
    const existing = Array.isArray(res?.[LOG_KEY]) ? (res[LOG_KEY] as string[]) : []
    const combined = existing.concat(pendingLines)
    pendingLines = []
    if (combined.length > MAX_LOG_LINES) {
      combined.splice(0, combined.length - MAX_LOG_LINES)
    }
    await store.set({ [LOG_KEY]: combined })
  } finally {
    flushInFlight = false
    if (pendingLines.length > 0) {
      queueFlush()
    }
  }
}

export const logExtensionEvent = (event: ExtensionLogEvent) => {
  const store = getStorage()
  if (!store) return
  const line = buildLogLine(event)
  pendingLines.push(line)
  if (pendingLines.length >= FLUSH_BATCH) {
    void flushPending()
    return
  }
  queueFlush()
}

export const readExtensionLogs = async (tail: number): Promise<ExtensionLogResult> => {
  const store = getStorage()
  if (!store) {
    return { ok: false, lines: [], truncated: false, sizeBytes: 0, mtimeMs: null }
  }
  const res = await store.get(LOG_KEY)
  const allLines = Array.isArray(res?.[LOG_KEY]) ? (res[LOG_KEY] as string[]) : []
  const total = allLines.length
  const normalizedTail = Math.max(1, Math.min(5000, Math.round(tail)))
  const lines = total > normalizedTail ? allLines.slice(total - normalizedTail) : allLines
  let mtimeMs: number | null = null
  if (allLines.length > 0) {
    const last = allLines[allLines.length - 1]
    try {
      const parsed = JSON.parse(last) as { date?: string }
      if (parsed?.date) {
        const parsedDate = new Date(parsed.date)
        const time = parsedDate.getTime()
        if (!Number.isNaN(time)) mtimeMs = time
      }
    } catch {
      // ignore
    }
  }
  const sizeBytes = allLines.reduce((sum, line) => sum + line.length, 0)
  return {
    ok: true,
    lines,
    truncated: total > lines.length,
    sizeBytes,
    mtimeMs,
  }
}
