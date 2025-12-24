import type { LinkPreviewProgressEvent } from '../content/link-preview/deps.js'

import { formatBytes, formatBytesPerSecond, formatElapsedMs } from './format.js'

export function createWebsiteProgress({
  enabled,
  spinner,
}: {
  enabled: boolean
  spinner: { setText: (text: string) => void }
}): {
  stop: () => void
  onProgress: (event: LinkPreviewProgressEvent) => void
} | null {
  if (!enabled) return null

  const state: {
    phase: 'fetching' | 'firecrawl' | 'bird' | 'nitter' | 'transcript' | 'idle'
    htmlDownloadedBytes: number
    htmlTotalBytes: number | null
    fetchStartedAtMs: number | null
    lastSpinnerUpdateAtMs: number
  } = {
    phase: 'idle',
    htmlDownloadedBytes: 0,
    htmlTotalBytes: null,
    fetchStartedAtMs: null,
    lastSpinnerUpdateAtMs: 0,
  }

  let ticker: ReturnType<typeof setInterval> | null = null

  const updateSpinner = (text: string, options?: { force?: boolean }) => {
    const now = Date.now()
    if (!options?.force && now - state.lastSpinnerUpdateAtMs < 100) return
    state.lastSpinnerUpdateAtMs = now
    spinner.setText(text)
  }

  const formatFirecrawlReason = (reason: string) => {
    const lower = reason.toLowerCase()
    if (lower.includes('forced')) return 'forced'
    if (lower.includes('html fetch failed')) return 'fallback: HTML fetch failed'
    if (lower.includes('blocked') || lower.includes('thin')) return 'fallback: blocked/thin HTML'
    return reason
  }

  const renderFetchLine = () => {
    const downloaded = formatBytes(state.htmlDownloadedBytes)
    const total =
      typeof state.htmlTotalBytes === 'number' &&
      state.htmlTotalBytes > 0 &&
      state.htmlDownloadedBytes <= state.htmlTotalBytes
        ? `/${formatBytes(state.htmlTotalBytes)}`
        : ''
    const elapsedMs =
      typeof state.fetchStartedAtMs === 'number' ? Date.now() - state.fetchStartedAtMs : 0
    const elapsed = formatElapsedMs(elapsedMs)
    if (state.htmlDownloadedBytes === 0 && !state.htmlTotalBytes) {
      return `Fetching website (connecting, ${elapsed})…`
    }
    const rate =
      elapsedMs > 0 && state.htmlDownloadedBytes > 0
        ? `, ${formatBytesPerSecond(state.htmlDownloadedBytes / (elapsedMs / 1000))}`
        : ''
    return `Fetching website (${downloaded}${total}, ${elapsed}${rate})…`
  }

  const startTicker = () => {
    if (ticker) return
    ticker = setInterval(() => {
      if (state.phase !== 'fetching') return
      updateSpinner(renderFetchLine())
    }, 1000)
  }

  const stopTicker = () => {
    if (!ticker) return
    clearInterval(ticker)
    ticker = null
  }

  // Tricky UX: the HTML fetch is often fast, but the next step can be slow (e.g. Whisper
  // transcription for podcast URLs). Stop the "Fetching website" ticker once the fetch is done so
  // elapsed time doesn’t keep increasing and look like a stuck download.
  const freezeFetchLine = () => {
    stopTicker()
    updateSpinner(renderFetchLine(), { force: true })
  }

  return {
    stop: stopTicker,
    onProgress: (event: LinkPreviewProgressEvent) => {
      if (event.kind === 'fetch-html-start') {
        state.phase = 'fetching'
        state.htmlDownloadedBytes = 0
        state.htmlTotalBytes = null
        state.fetchStartedAtMs = Date.now()
        startTicker()
        updateSpinner('Fetching website (connecting)…')
        return
      }

      if (event.kind === 'fetch-html-progress') {
        state.phase = 'fetching'
        state.htmlDownloadedBytes = event.downloadedBytes
        state.htmlTotalBytes = event.totalBytes
        updateSpinner(renderFetchLine())
        return
      }

      if (event.kind === 'fetch-html-done') {
        state.phase = 'idle'
        state.htmlDownloadedBytes = event.downloadedBytes
        state.htmlTotalBytes = event.totalBytes
        freezeFetchLine()
        return
      }

      if (event.kind === 'bird-start') {
        state.phase = 'bird'
        stopTicker()
        updateSpinner('Bird: reading tweet…', { force: true })
        return
      }

      if (event.kind === 'bird-done') {
        state.phase = 'bird'
        stopTicker()
        if (event.ok && typeof event.textBytes === 'number') {
          updateSpinner(`Bird: got ${formatBytes(event.textBytes)}…`, { force: true })
          return
        }
        updateSpinner('Bird: failed; fallback…', { force: true })
        return
      }

      if (event.kind === 'nitter-start') {
        state.phase = 'nitter'
        stopTicker()
        updateSpinner('Nitter: fetching…', { force: true })
        return
      }

      if (event.kind === 'nitter-done') {
        state.phase = 'nitter'
        stopTicker()
        if (event.ok && typeof event.textBytes === 'number') {
          updateSpinner(`Nitter: got ${formatBytes(event.textBytes)}…`, { force: true })
          return
        }
        updateSpinner('Nitter: failed; fallback…', { force: true })
        return
      }

      if (event.kind === 'firecrawl-start') {
        state.phase = 'firecrawl'
        stopTicker()
        const reason = event.reason ? formatFirecrawlReason(event.reason) : ''
        const suffix = reason ? ` (${reason})` : ''
        updateSpinner(`Firecrawl: scraping${suffix}…`, { force: true })
        return
      }

      if (event.kind === 'firecrawl-done') {
        state.phase = 'firecrawl'
        stopTicker()
        if (event.ok && typeof event.markdownBytes === 'number') {
          updateSpinner(`Firecrawl: got ${formatBytes(event.markdownBytes)}…`, { force: true })
          return
        }
        updateSpinner('Firecrawl: no content; fallback…', { force: true })
        return
      }

      if (event.kind === 'transcript-start') {
        state.phase = 'transcript'
        stopTicker()
        const hint = event.hint ? ` (${event.hint})` : ''
        updateSpinner(`Transcribing${hint}…`, { force: true })
        return
      }

      if (event.kind === 'transcript-done') {
        state.phase = 'transcript'
        stopTicker()
        updateSpinner(event.ok ? 'Transcribed…' : 'Transcript failed; fallback…', { force: true })
      }
    },
  }
}

