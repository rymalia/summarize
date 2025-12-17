import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../packages/cli/src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

describe('cli OpenAI response parsing', () => {
  it('accepts message.content as typed content parts', async () => {
    const html =
      '<!doctype html><html><head><title>Hello</title></head>' +
      '<body><article><p>Hi</p></article></body></html>'

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(html)
      }
      if (url === 'https://api.openai.com/v1/chat/completions') {
        return Response.json(
          {
            choices: [
              {
                message: {
                  content: [{ type: 'text', text: 'OK' }],
                },
              },
            ],
          },
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
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

    const stderr = new Writable({
      write(chunk, encoding, callback) {
        void chunk
        void encoding
        callback()
      },
    })

    await runCli(['--timeout', '10s', 'https://example.com'], {
      env: { OPENAI_API_KEY: 'test' },
      fetch: fetchMock as unknown as typeof fetch,
      stdout,
      stderr,
    })

    expect(stdoutText.trim()).toBe('OK')
  })
})
