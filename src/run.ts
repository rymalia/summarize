import { Command } from 'commander'
import { createLinkPreviewClient } from './content/index.js'
import { createFirecrawlScraper } from './firecrawl.js'
import { parseDurationMs, parseFirecrawlMode, parseLengthArg, parseYoutubeMode } from './flags.js'
import {
  buildLinkSummaryPrompt,
  estimateMaxCompletionTokensForCharacters,
  SUMMARY_LENGTH_TO_TOKENS,
} from './prompts/index.js'

type RunEnv = {
  env: Record<string, string | undefined>
  fetch: typeof fetch
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

type JsonOutput = {
  input: {
    url: string
    timeoutMs: number
    youtube: string
    firecrawl: string
    length: { kind: 'preset'; preset: string } | { kind: 'chars'; maxCharacters: number }
  }
  env: {
    hasOpenAIKey: boolean
    hasApifyToken: boolean
    hasFirecrawlKey: boolean
  }
  extracted: unknown
  prompt: string
  openai: {
    model: string
    maxCompletionTokens: number
    strategy: 'single' | 'map-reduce'
    chunkCount: number
  } | null
  summary: string | null
}

const MAP_REDUCE_TRIGGER_CHARACTERS = 120_000
const MAP_REDUCE_CHUNK_CHARACTERS = 60_000

function buildProgram() {
  return new Command()
    .name('summarize')
    .description(
      'Summarize web pages and YouTube links (prompt-only when OPENAI_API_KEY is missing).'
    )
    .argument('[url]', 'URL to summarize')
    .option(
      '--youtube <mode>',
      'YouTube transcript source: auto (web then apify), web (youtubei/captionTracks), apify',
      'auto'
    )
    .option(
      '--firecrawl <mode>',
      'Firecrawl usage: off, auto (fallback), always (try Firecrawl first). Note: in --extract-only website mode, defaults to always.',
      'auto'
    )
    .option(
      '--length <length>',
      'Summary length: short|medium|long|xl|xxl or a character limit like 20000, 20k',
      'medium'
    )
    .option(
      '--timeout <duration>',
      'Timeout for content fetching and OpenAI request: 30 (seconds), 30s, 2m, 5000ms',
      '30s'
    )
    .option('--model <model>', 'OpenAI model', undefined)
    .option('--prompt', 'Print the prompt and exit', false)
    .option('--extract-only', 'Print extracted content and exit', false)
    .option('--json', 'Output structured JSON', false)
    .option('--verbose', 'Print detailed progress info to stderr', false)
    .allowExcessArguments(false)
}

async function summarizeWithOpenAI({
  apiKey,
  model,
  prompt,
  maxOutputTokens,
  timeoutMs,
  fetchImpl,
}: {
  apiKey: string
  model: string
  prompt: string
  maxOutputTokens: number
  timeoutMs: number
  fetchImpl: typeof fetch
}): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_completion_tokens: maxOutputTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`OpenAI request failed (${response.status}): ${body}`)
    }

    const json = (await response.json()) as unknown
    const firstMessage = readFirstChoiceMessage(json)
    if (!firstMessage) {
      const error = new Error('OpenAI response missing message content')
      error.name = 'OpenAIResponseFormatError'
      throw error
    }

    const { content, refusal } = readMessageContentOrRefusal(firstMessage)
    if (content === null) {
      if (refusal) {
        throw new Error(`OpenAI refusal: ${refusal}`)
      }

      const error = new Error('OpenAI response missing message content')
      error.name = 'OpenAIResponseFormatError'
      throw error
    }

    return content
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('OpenAI request timed out')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

type ChatCompletionMessage = Record<string, unknown> & {
  content?: unknown
  refusal?: unknown
}

type ChatCompletionContentPart = Record<string, unknown> & {
  type?: unknown
  text?: unknown
}

function readFirstChoiceMessage(payload: unknown): ChatCompletionMessage | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const choices = (payload as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    return null
  }
  const first = choices[0]
  if (!first || typeof first !== 'object') {
    return null
  }
  const message = (first as Record<string, unknown>).message
  if (!message || typeof message !== 'object') {
    return null
  }
  return message as ChatCompletionMessage
}

function readMessageContentOrRefusal(message: ChatCompletionMessage): {
  content: string | null
  refusal: string | null
} {
  const refusal = typeof message.refusal === 'string' ? message.refusal : null
  const content = message.content

  if (typeof content === 'string') {
    return { content, refusal }
  }

  if (Array.isArray(content)) {
    const text = content
      .map((partUnknown) => {
        if (!partUnknown || typeof partUnknown !== 'object') {
          return ''
        }
        const part = partUnknown as ChatCompletionContentPart
        if (part.type !== 'text') {
          return ''
        }
        return typeof part.text === 'string' ? part.text : ''
      })
      .join('')
    return { content: text, refusal }
  }

  return { content: null, refusal }
}

function splitTextIntoChunks(input: string, maxCharacters: number): string[] {
  if (maxCharacters <= 0) {
    return [input]
  }

  const text = input.trim()
  if (text.length <= maxCharacters) {
    return [text]
  }

  const chunks: string[] = []
  let offset = 0
  while (offset < text.length) {
    const end = Math.min(offset + maxCharacters, text.length)
    const slice = text.slice(offset, end)

    if (end === text.length) {
      chunks.push(slice.trim())
      break
    }

    const candidateBreaks = [
      slice.lastIndexOf('\n\n'),
      slice.lastIndexOf('\n'),
      slice.lastIndexOf('. '),
    ]
    const lastBreak = Math.max(...candidateBreaks)
    const splitAt = lastBreak > Math.floor(maxCharacters * 0.5) ? lastBreak + 1 : slice.length
    const chunk = slice.slice(0, splitAt).trim()
    if (chunk.length > 0) {
      chunks.push(chunk)
    }

    offset += splitAt
  }

  return chunks.filter((chunk) => chunk.length > 0)
}

const VERBOSE_PREFIX = '[summarize]'

function writeVerbose(stderr: NodeJS.WritableStream, verbose: boolean, message: string): void {
  if (!verbose) {
    return
  }
  stderr.write(`${VERBOSE_PREFIX} ${message}\n`)
}

function formatOptionalString(value: string | null | undefined): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  return 'none'
}

function formatOptionalNumber(value: number | null | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  return 'none'
}

function buildChunkNotesPrompt({ content }: { content: string }): string {
  return `Return 10 bullet points summarizing the content below (Markdown).

CONTENT:
"""
${content}
"""
`
}

export async function runCli(
  argv: string[],
  { env, fetch, stdout, stderr }: RunEnv
): Promise<void> {
  const normalizedArgv = argv.filter((arg) => arg !== '--')
  const program = buildProgram()
  program.parse(normalizedArgv, { from: 'user' })

  const url = program.args[0]
  if (!url) {
    throw new Error(
      'Usage: summarize <url> [--youtube auto|web|apify] [--length 20k] [--timeout 30s] [--json]'
    )
  }

  const youtubeMode = parseYoutubeMode(program.opts().youtube as string)
  const lengthArg = parseLengthArg(program.opts().length as string)
  const timeoutMs = parseDurationMs(program.opts().timeout as string)
  const printPrompt = Boolean(program.opts().prompt)
  const extractOnly = Boolean(program.opts().extractOnly)
  const json = Boolean(program.opts().json)
  const verbose = Boolean(program.opts().verbose)

  if (printPrompt && extractOnly) {
    throw new Error('--prompt and --extract-only are mutually exclusive')
  }

  const isYoutubeUrl = /youtube\.com|youtu\.be/i.test(url)
  const firecrawlExplicitlySet = normalizedArgv.some(
    (arg) => arg === '--firecrawl' || arg.startsWith('--firecrawl=')
  )
  const firecrawlMode = (() => {
    const parsed = parseFirecrawlMode(program.opts().firecrawl as string)
    if (extractOnly && !isYoutubeUrl && !firecrawlExplicitlySet) {
      return 'always'
    }
    return parsed
  })()

  const model =
    (typeof program.opts().model === 'string' ? (program.opts().model as string) : null) ??
    env.OPENAI_MODEL ??
    'gpt-5.2'

  const apiKey = typeof env.OPENAI_API_KEY === 'string' ? env.OPENAI_API_KEY : null
  const apifyToken = typeof env.APIFY_API_TOKEN === 'string' ? env.APIFY_API_TOKEN : null
  const firecrawlKey = typeof env.FIRECRAWL_API_KEY === 'string' ? env.FIRECRAWL_API_KEY : null

  const firecrawlApiKey = firecrawlKey && firecrawlKey.trim().length > 0 ? firecrawlKey : null
  const firecrawlConfigured = firecrawlApiKey !== null
  if (firecrawlMode === 'always' && !firecrawlConfigured) {
    throw new Error('--firecrawl always requires FIRECRAWL_API_KEY')
  }

  writeVerbose(
    stderr,
    verbose,
    `config url=${url} timeoutMs=${timeoutMs} youtube=${youtubeMode} firecrawl=${firecrawlMode} length=${
      lengthArg.kind === 'preset' ? lengthArg.preset : `${lengthArg.maxCharacters} chars`
    } json=${json} extractOnly=${extractOnly} prompt=${printPrompt}`
  )
  writeVerbose(
    stderr,
    verbose,
    `env openaiKey=${Boolean(apiKey)} apifyToken=${Boolean(apifyToken)} firecrawlKey=${firecrawlConfigured} model=${model}`
  )

  const scrapeWithFirecrawl =
    firecrawlConfigured && firecrawlMode !== 'off'
      ? createFirecrawlScraper({ apiKey: firecrawlApiKey, fetchImpl: fetch })
      : null

  const client = createLinkPreviewClient({
    apifyApiToken: apifyToken,
    scrapeWithFirecrawl,
    fetch,
  })

  writeVerbose(stderr, verbose, 'extract start')
  const extracted = await client.fetchLinkContent(url, {
    timeoutMs,
    youtubeTranscript: youtubeMode,
    firecrawl: firecrawlMode,
  })
  writeVerbose(
    stderr,
    verbose,
    `extract done strategy=${extracted.diagnostics.strategy} siteName=${formatOptionalString(
      extracted.siteName
    )} title=${formatOptionalString(extracted.title)} transcriptSource=${formatOptionalString(
      extracted.transcriptSource
    )}`
  )
  writeVerbose(
    stderr,
    verbose,
    `extract stats characters=${extracted.totalCharacters} words=${extracted.wordCount} transcriptCharacters=${formatOptionalNumber(
      extracted.transcriptCharacters
    )} transcriptLines=${formatOptionalNumber(extracted.transcriptLines)}`
  )
  writeVerbose(
    stderr,
    verbose,
    `extract firecrawl attempted=${extracted.diagnostics.firecrawl.attempted} used=${extracted.diagnostics.firecrawl.used} notes=${formatOptionalString(
      extracted.diagnostics.firecrawl.notes ?? null
    )}`
  )
  writeVerbose(
    stderr,
    verbose,
    `extract transcript textProvided=${extracted.diagnostics.transcript.textProvided} provider=${formatOptionalString(
      extracted.diagnostics.transcript.provider ?? null
    )} attemptedProviders=${
      extracted.diagnostics.transcript.attemptedProviders.length > 0
        ? extracted.diagnostics.transcript.attemptedProviders.join(',')
        : 'none'
    } notes=${formatOptionalString(extracted.diagnostics.transcript.notes ?? null)}`
  )

  const isYouTube = extracted.siteName === 'YouTube'
  const prompt = buildLinkSummaryPrompt({
    url: extracted.url,
    title: extracted.title,
    siteName: extracted.siteName,
    description: extracted.description,
    content: extracted.content,
    truncated: false,
    hasTranscript:
      isYouTube ||
      (extracted.transcriptSource !== null && extracted.transcriptSource !== 'unavailable'),
    summaryLength:
      lengthArg.kind === 'preset' ? lengthArg.preset : { maxCharacters: lengthArg.maxCharacters },
    shares: [],
  })

  if (extractOnly) {
    if (json) {
      const payload: JsonOutput = {
        input: {
          url,
          timeoutMs,
          youtube: youtubeMode,
          firecrawl: firecrawlMode,
          length:
            lengthArg.kind === 'preset'
              ? { kind: 'preset', preset: lengthArg.preset }
              : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
        },
        env: {
          hasOpenAIKey: Boolean(apiKey),
          hasApifyToken: Boolean(apifyToken),
          hasFirecrawlKey: firecrawlConfigured,
        },
        extracted,
        prompt,
        openai: null,
        summary: null,
      }
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return
    }

    stdout.write(`${extracted.content}\n`)
    return
  }

  if (printPrompt || !apiKey) {
    writeVerbose(
      stderr,
      verbose,
      printPrompt ? 'mode prompt-only' : 'mode prompt-only (no OPENAI_API_KEY)'
    )
    if (!apiKey && !json) {
      stderr.write('Missing OPENAI_API_KEY; printing prompt instead.\n')
    }

    if (json) {
      const payload: JsonOutput = {
        input: {
          url,
          timeoutMs,
          youtube: youtubeMode,
          firecrawl: firecrawlMode,
          length:
            lengthArg.kind === 'preset'
              ? { kind: 'preset', preset: lengthArg.preset }
              : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
        },
        env: {
          hasOpenAIKey: Boolean(apiKey),
          hasApifyToken: Boolean(apifyToken),
          hasFirecrawlKey: firecrawlConfigured,
        },
        extracted,
        prompt,
        openai: null,
        summary: null,
      }
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return
    }

    stdout.write(`${prompt}\n`)
    return
  }

  writeVerbose(stderr, verbose, 'mode summarize (OpenAI)')
  const maxCompletionTokens =
    lengthArg.kind === 'preset'
      ? SUMMARY_LENGTH_TO_TOKENS[lengthArg.preset]
      : estimateMaxCompletionTokensForCharacters(lengthArg.maxCharacters)

  const isLargeContent = extracted.content.length >= MAP_REDUCE_TRIGGER_CHARACTERS
  let strategy: 'single' | 'map-reduce' = 'single'
  let chunkCount = 1

  let summary: string
  if (!isLargeContent) {
    writeVerbose(stderr, verbose, 'summarize strategy=single')
    summary = await summarizeWithOpenAI({
      apiKey,
      model,
      prompt,
      maxOutputTokens: maxCompletionTokens,
      timeoutMs,
      fetchImpl: fetch,
    })
  } else {
    strategy = 'map-reduce'
    const chunks = splitTextIntoChunks(extracted.content, MAP_REDUCE_CHUNK_CHARACTERS)
    chunkCount = chunks.length

    stderr.write(
      `Large input (${extracted.content.length} chars); summarizing in ${chunks.length} chunks.\n`
    )
    writeVerbose(stderr, verbose, `summarize strategy=map-reduce chunks=${chunks.length}`)

    const chunkNotes: string[] = []
    for (let i = 0; i < chunks.length; i += 1) {
      writeVerbose(stderr, verbose, `summarize chunk ${i + 1}/${chunks.length} notes start`)
      const chunkPrompt = buildChunkNotesPrompt({
        content: chunks[i] ?? '',
      })

      let notes = ''
      try {
        notes = await summarizeWithOpenAI({
          apiKey,
          model,
          prompt: chunkPrompt,
          maxOutputTokens: SUMMARY_LENGTH_TO_TOKENS.medium,
          timeoutMs,
          fetchImpl: fetch,
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'OpenAIResponseFormatError') {
          stderr.write(`OpenAI returned an empty response for chunk ${i + 1}; skipping.\n`)
          continue
        }
        throw error
      }

      chunkNotes.push(notes.trim())
    }

    writeVerbose(stderr, verbose, 'summarize merge chunk notes')
    const mergedContent = `Chunk notes (generated from the full input):\n\n${chunkNotes
      .filter((value) => value.length > 0)
      .join('\n\n')}`

    const mergedPrompt = buildLinkSummaryPrompt({
      url: extracted.url,
      title: extracted.title,
      siteName: extracted.siteName,
      description: extracted.description,
      content: mergedContent,
      truncated: false,
      hasTranscript:
        isYouTube ||
        (extracted.transcriptSource !== null && extracted.transcriptSource !== 'unavailable'),
      summaryLength:
        lengthArg.kind === 'preset' ? lengthArg.preset : { maxCharacters: lengthArg.maxCharacters },
      shares: [],
    })

    summary = await summarizeWithOpenAI({
      apiKey,
      model,
      prompt: mergedPrompt,
      maxOutputTokens: maxCompletionTokens,
      timeoutMs,
      fetchImpl: fetch,
    })
  }

  summary = summary.trim()
  if (summary.length === 0) {
    throw new Error('OpenAI returned an empty summary')
  }

  if (json) {
    const payload: JsonOutput = {
      input: {
        url,
        timeoutMs,
        youtube: youtubeMode,
        firecrawl: firecrawlMode,
        length:
          lengthArg.kind === 'preset'
            ? { kind: 'preset', preset: lengthArg.preset }
            : { kind: 'chars', maxCharacters: lengthArg.maxCharacters },
      },
      env: {
        hasOpenAIKey: true,
        hasApifyToken: Boolean(apifyToken),
        hasFirecrawlKey: firecrawlConfigured,
      },
      extracted,
      prompt,
      openai: { model, maxCompletionTokens, strategy, chunkCount },
      summary,
    }

    stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }

  stdout.write(`${summary}\n`)
}
