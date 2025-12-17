import type { LinkPreviewDeps } from '../deps.js'
import type { TranscriptDiagnostics, TranscriptResolution } from '../types.js'
import {
  canHandle as canHandleGeneric,
  fetchTranscript as fetchGeneric,
} from './providers/generic.js'
import {
  canHandle as canHandlePodcast,
  fetchTranscript as fetchPodcast,
} from './providers/podcast.js'
import {
  canHandle as canHandleYoutube,
  fetchTranscript as fetchYoutube,
} from './providers/youtube.js'
import type {
  ProviderContext,
  ProviderFetchOptions,
  ProviderModule,
  ProviderResult,
} from './types.js'
import {
  extractYouTubeVideoId as extractYouTubeVideoIdInternal,
  isYouTubeUrl as isYouTubeUrlInternal,
} from './utils.js'

interface ResolveTranscriptOptions {
  youtubeTranscriptMode?: ProviderFetchOptions['youtubeTranscriptMode']
}

const PROVIDERS: ProviderModule[] = [
  { id: 'youtube', canHandle: canHandleYoutube, fetchTranscript: fetchYoutube },
  { id: 'podcast', canHandle: canHandlePodcast, fetchTranscript: fetchPodcast },
  { id: 'generic', canHandle: canHandleGeneric, fetchTranscript: fetchGeneric },
]
const GENERIC_PROVIDER_ID = 'generic'

export const resolveTranscriptForLink = async (
  url: string,
  html: string | null,
  deps: LinkPreviewDeps,
  { youtubeTranscriptMode }: ResolveTranscriptOptions = {}
): Promise<TranscriptResolution> => {
  const normalizedUrl = url.trim()
  const resourceKey = extractResourceKey(normalizedUrl)
  const baseContext: ProviderContext = { url: normalizedUrl, html, resourceKey }
  const provider: ProviderModule = selectProvider(baseContext)
  const diagnostics: TranscriptDiagnostics = {
    attemptedProviders: [],
    notes: null,
    provider: null,
    textProvided: false,
  }

  const providerResult = await executeProvider(provider, baseContext, {
    fetch: deps.fetch,
    apifyApiToken: deps.apifyApiToken,
    youtubeTranscriptMode: youtubeTranscriptMode ?? 'auto',
  })
  diagnostics.provider = providerResult.source
  diagnostics.attemptedProviders = providerResult.attemptedProviders
  diagnostics.textProvided = Boolean(providerResult.text && providerResult.text.length > 0)

  return {
    text: providerResult.text,
    source: providerResult.source,
    diagnostics,
  }
}

const extractResourceKey = (url: string): string | null => {
  if (isYouTubeUrlInternal(url)) {
    return extractYouTubeVideoIdInternal(url)
  }
  return null
}

const selectProvider = (context: ProviderContext): ProviderModule => {
  const genericProviderModule = PROVIDERS.find((provider) => provider.id === GENERIC_PROVIDER_ID)

  const specializedProvider = PROVIDERS.find(
    (provider) => provider.id !== GENERIC_PROVIDER_ID && provider.canHandle(context)
  )
  if (specializedProvider) {
    return specializedProvider
  }

  if (genericProviderModule) {
    return genericProviderModule
  }

  throw new Error('Generic transcript provider is not registered')
}

const executeProvider = async (
  provider: ProviderModule,
  context: ProviderContext,
  options: ProviderFetchOptions
): Promise<ProviderResult> => provider.fetchTranscript(context, options)
