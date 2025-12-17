import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

describe('cli --extract-only', () => {
  it('prints full extracted content (no truncation) and never calls OpenAI', async () => {
    const body = 'A'.repeat(60_000)
    const markdown = `# Example\n\n${body}`

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://api.firecrawl.dev/v1/scrape') {
        const parsed = init?.body ? (JSON.parse(String(init.body)) as { url?: unknown }) : null
        expect(parsed?.url).toBe('https://example.com')
        return Response.json(
          { success: true, data: { markdown, html: null, metadata: { title: 'Example' } } },
          { status: 200 }
        )
      }
      if (url === 'https://api.openai.com/v1/chat/completions') {
        throw new Error('Unexpected OpenAI call in --extract-only mode')
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })

    await runCli(['--extract-only', '--timeout', '2s', 'https://example.com'], {
      env: { OPENAI_API_KEY: 'test', FIRECRAWL_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr: new Writable({
        write(_chunk, _encoding, cb) {
          cb()
        },
      }),
    })

    expect(stdoutText.startsWith('# Example')).toBe(true)
    expect(stdoutText.length).toBeGreaterThanOrEqual(59_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
