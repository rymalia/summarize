function normalizeStreamText(input: string): string {
  return input.replace(/\r\n?/g, '\n')
}

function commonPrefixLength(a: string, b: string, limit = 4096): number {
  const max = Math.min(a.length, b.length, limit)
  let i = 0
  for (; i < max; i += 1) {
    if (a[i] !== b[i]) break
  }
  return i
}

// Streaming APIs sometimes resend partial output; stitch using prefix/overlap heuristics.
export function mergeStreamingChunk(
  previous: string,
  chunk: string
): { next: string; appended: string } {
  if (!chunk) return { next: previous, appended: '' }
  const prev = normalizeStreamText(previous)
  const nextChunk = normalizeStreamText(chunk)
  if (!prev) return { next: nextChunk, appended: nextChunk }
  if (nextChunk.startsWith(prev)) {
    return { next: nextChunk, appended: nextChunk.slice(prev.length) }
  }
  if (prev.startsWith(nextChunk)) {
    return { next: prev, appended: '' }
  }
  if (nextChunk.length >= prev.length) {
    const prefixLen = commonPrefixLength(prev, nextChunk)
    if (prefixLen > 0) {
      const minPrefix = Math.max(prev.length - 64, Math.floor(prev.length * 0.9))
      if (prefixLen >= minPrefix) {
        return { next: nextChunk, appended: nextChunk.slice(prefixLen) }
      }
    }
  }
  const maxOverlap = Math.min(prev.length, nextChunk.length, 2048)
  for (let len = maxOverlap; len > 0; len -= 1) {
    if (prev.slice(-len) === nextChunk.slice(0, len)) {
      return { next: prev + nextChunk.slice(len), appended: nextChunk.slice(len) }
    }
  }
  return { next: prev + nextChunk, appended: nextChunk }
}

export function isGoogleStreamingUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const maybe = error as Record<string, unknown>
  const message = typeof maybe.message === 'string' ? maybe.message : ''
  const url = typeof maybe.url === 'string' ? maybe.url : ''
  const responseBody = typeof maybe.responseBody === 'string' ? maybe.responseBody : ''
  const errorText = `${message}\n${responseBody}`

  const isStreamEndpoint =
    url.includes(':streamGenerateContent') || errorText.includes('streamGenerateContent')
  if (!isStreamEndpoint) return false

  return (
    /does not support/i.test(errorText) ||
    /not supported/i.test(errorText) ||
    /Call ListModels/i.test(errorText) ||
    /supported methods/i.test(errorText)
  )
}

export function isStreamingTimeoutError(error: unknown): boolean {
  if (!error) return false
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown }).message === 'string'
          ? String((error as { message?: unknown }).message)
          : ''
  return /timed out/i.test(message)
}
