import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadSummarizeConfig } from '../src/config.js'

describe('config error handling', () => {
  it('throws on invalid JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configPath = join(root, '.summarize', 'config.json')
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(configPath, '{not json', 'utf8')

    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /Invalid JSON in config file/
    )
  })

  it('throws when config contains comments', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configPath = join(root, '.summarize', 'config.json')
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(
      configPath,
      '{\n  // no comments\n  "model": { "id": "openai/gpt-5.2" }\n}\n',
      'utf8'
    )

    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/comments are not allowed/i)
  })

  it('throws when top-level is not an object', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configPath = join(root, '.summarize', 'config.json')
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(configPath, JSON.stringify(['nope']), 'utf8')

    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/expected an object/)
  })

  it('throws when model is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configPath = join(root, '.summarize', 'config.json')
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ model: '   ' }), 'utf8')

    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/"model" must not be empty/i)
  })

  it('throws when top-level auto is present (legacy)', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configPath = join(root, '.summarize', 'config.json')
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(configPath, JSON.stringify({ model: { mode: 'auto' }, auto: [] }), 'utf8')

    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/top-level "auto"/i)
  })

  it('throws when model.rules is not an array', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configPath = join(root, '.summarize', 'config.json')
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({ model: { mode: 'auto', rules: { nope: true } } }),
      'utf8'
    )

    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /"model\.rules" must be an array/i
    )
  })

  it('throws when model.rules[].when is not an array', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configPath = join(root, '.summarize', 'config.json')
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        model: {
          mode: 'auto',
          rules: [{ when: { kind: 'video' }, candidates: ['openai/gpt-5-nano'] }],
        },
      }),
      'utf8'
    )

    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /model\.rules\[\]\.when.*must be an array/i
    )
  })

  it('throws when model.rules[].when is empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configPath = join(root, '.summarize', 'config.json')
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        model: { mode: 'auto', rules: [{ when: [], candidates: ['openai/gpt-5-nano'] }] },
      }),
      'utf8'
    )

    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(
      /model\.rules\[\]\.when.*must not be empty/i
    )
  })

  it('throws when model.rules[].when contains unknown kinds', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-config-'))
    const configPath = join(root, '.summarize', 'config.json')
    mkdirSync(join(root, '.summarize'), { recursive: true })
    writeFileSync(
      configPath,
      JSON.stringify({
        model: { mode: 'auto', rules: [{ when: ['nope'], candidates: ['openai/gpt-5-nano'] }] },
      }),
      'utf8'
    )

    expect(() => loadSummarizeConfig({ env: { HOME: root } })).toThrow(/unknown "when" kind/i)
  })
})
