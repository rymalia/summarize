import { describe, expect, it, vi } from 'vitest'
import { createLinkPreviewClient } from '../src/content/index.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

describe('link preview extraction (json-ld podcast preference)', () => {
  it('prefers podcast JSON-LD description over noisy page text', async () => {
    const description = 'D'.repeat(220)
    const navText = 'Other podcast listing that should be ignored in output'
    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'PodcastEpisode',
      name: 'Episode 1',
      description,
    })

    const html = `<!doctype html><html><head>
      <title>Episode 1</title>
      <script type="application/ld+json">${jsonLd}</script>
    </head><body>
      <nav><ul><li>${navText}</li></ul></nav>
      <section><p>${navText} ${navText} ${navText}</p></section>
    </body></html>`

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const client = createLinkPreviewClient({
      fetch: fetchMock as unknown as typeof fetch,
    })

    const result = await client.fetchLinkContent('https://example.com', {
      timeoutMs: 2000,
      firecrawl: 'off',
      format: 'text',
    })

    expect(result.content).toContain(description)
    expect(result.content).not.toContain(navText)
  })
})
