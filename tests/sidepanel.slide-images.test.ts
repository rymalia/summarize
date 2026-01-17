import { describe, expect, it } from 'vitest'

import { normalizeSlideImageUrl } from '../apps/chrome-extension/src/entrypoints/sidepanel/slide-images'

describe('sidepanel slide image urls', () => {
  it('keeps stable slide urls', () => {
    const url = 'http://127.0.0.1:8787/v1/slides/abc/3?v=2'
    expect(normalizeSlideImageUrl(url, 'abc', 3)).toBe(url)
  })

  it('rewrites session slide urls to stable endpoint', () => {
    const url = 'http://127.0.0.1:8787/v1/summarize/xyz/slides/7?v=4'
    expect(normalizeSlideImageUrl(url, 'abc', 7)).toBe('http://127.0.0.1:8787/v1/slides/abc/7?v=4')
  })

  it('leaves non-daemon urls untouched', () => {
    const url = 'https://example.com/slide.png'
    expect(normalizeSlideImageUrl(url, 'abc', 1)).toBe(url)
  })
})
