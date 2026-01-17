// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createSlideImageLoader } from '../apps/chrome-extension/src/entrypoints/sidepanel/slide-images'
import type { Settings } from '../apps/chrome-extension/src/lib/settings'

const originalFetch = globalThis.fetch
const originalCreateObjectUrl = URL.createObjectURL
const originalIntersectionObserver = globalThis.IntersectionObserver

afterEach(() => {
  globalThis.fetch = originalFetch
  URL.createObjectURL = originalCreateObjectUrl
  globalThis.IntersectionObserver = originalIntersectionObserver
  document.body.replaceChildren()
})

describe('slide image loader', () => {
  it('loads images when ready', async () => {
    globalThis.IntersectionObserver = undefined
    globalThis.fetch = vi.fn(async () => {
      const blob = new Blob(['ok'], { type: 'image/png' })
      return new Response(blob, {
        status: 200,
        headers: { 'x-summarize-slide-ready': '1' },
      })
    })
    URL.createObjectURL = vi.fn(() => 'blob:mock')

    const loader = createSlideImageLoader({
      loadSettings: async () => ({ token: 't', extendedLogging: false }) as Settings,
    })
    const wrapper = document.createElement('div')
    wrapper.className = 'slideStrip__thumb'
    const img = document.createElement('img')
    wrapper.appendChild(img)
    document.body.appendChild(wrapper)

    loader.observe(img, 'http://127.0.0.1:8787/v1/slides/abc/1')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(img.getAttribute('src')).toBe('blob:mock')
    img.dispatchEvent(new Event('load'))
    expect(img.dataset.loaded).toBe('true')
  })

  it('schedules retries when slide is not ready', async () => {
    globalThis.IntersectionObserver = undefined
    globalThis.fetch = vi.fn(async () => {
      const blob = new Blob(['wait'], { type: 'image/png' })
      return new Response(blob, {
        status: 200,
        headers: { 'x-summarize-slide-ready': '0' },
      })
    })
    URL.createObjectURL = vi.fn(() => 'blob:mock')

    const loader = createSlideImageLoader({
      loadSettings: async () => ({ token: 't', extendedLogging: false }) as Settings,
    })
    const wrapper = document.createElement('div')
    wrapper.className = 'slideStrip__thumb'
    const img = document.createElement('img')
    wrapper.appendChild(img)
    document.body.appendChild(wrapper)

    loader.observe(img, 'http://127.0.0.1:8787/v1/slides/abc/2')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(img.dataset.slideRetryCount).toBe('1')
    expect(img.src).toBe('')
  })
})
