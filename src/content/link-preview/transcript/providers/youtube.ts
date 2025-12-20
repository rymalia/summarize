import { normalizeTranscriptText } from '../normalize.js'
import type {
  ProviderContext,
  ProviderFetchOptions,
  ProviderResult,
  TranscriptSource,
} from '../types.js'
import { extractYouTubeVideoId } from '../utils.js'
import {
  extractYoutubeiTranscriptConfig,
  fetchTranscriptFromTranscriptEndpoint,
} from './youtube/api.js'
import { fetchTranscriptWithApify } from './youtube/apify.js'
import { fetchTranscriptFromCaptionTracks } from './youtube/captions.js'
import { fetchTranscriptWithYtDlp } from './youtube/yt-dlp.js'

const YOUTUBE_URL_PATTERN = /youtube\.com|youtu\.be/i

export const canHandle = ({ url }: ProviderContext): boolean => YOUTUBE_URL_PATTERN.test(url)

export const fetchTranscript = async (
  context: ProviderContext,
  options: ProviderFetchOptions
): Promise<ProviderResult> => {
  const attemptedProviders: TranscriptSource[] = []
  const notes: string[] = []
  const { html, url } = context
  const mode = options.youtubeTranscriptMode
  const hasYtDlpCredentials = Boolean(options.openaiApiKey || options.falApiKey)
  const canRunYtDlp = Boolean(options.ytDlpPath && hasYtDlpCredentials)

  if (mode === 'yt-dlp' && !options.ytDlpPath) {
    throw new Error('Missing YT_DLP_PATH for --youtube yt-dlp')
  }
  if (mode === 'yt-dlp' && !hasYtDlpCredentials) {
    throw new Error('Missing OPENAI_API_KEY or FAL_KEY for --youtube yt-dlp')
  }

  if (!html) {
    return { text: null, source: null, attemptedProviders }
  }

  const effectiveVideoIdCandidate = context.resourceKey ?? extractYouTubeVideoId(url)
  const effectiveVideoId =
    typeof effectiveVideoIdCandidate === 'string' && effectiveVideoIdCandidate.trim().length > 0
      ? effectiveVideoIdCandidate.trim()
      : null
  if (!effectiveVideoId) {
    return { text: null, source: null, attemptedProviders }
  }

  // Try web methods (youtubei, captionTracks) if mode is 'auto' or 'web'
  if (mode === 'auto' || mode === 'web') {
    const config = extractYoutubeiTranscriptConfig(html)
    if (config) {
      attemptedProviders.push('youtubei')
      const transcript = await fetchTranscriptFromTranscriptEndpoint(options.fetch, {
        config,
        originalUrl: url,
      })
      if (transcript) {
        return {
          text: normalizeTranscriptText(transcript),
          source: 'youtubei',
          metadata: { provider: 'youtubei' },
          attemptedProviders,
        }
      }
    }

    attemptedProviders.push('captionTracks')
    const captionTranscript = await fetchTranscriptFromCaptionTracks(options.fetch, {
      html,
      originalUrl: url,
      videoId: effectiveVideoId,
    })
    if (captionTranscript) {
      return {
        text: normalizeTranscriptText(captionTranscript),
        source: 'captionTracks',
        metadata: { provider: 'captionTracks' },
        attemptedProviders,
      }
    }
  }

  // Try apify if mode is 'auto' or 'apify'
  if (mode === 'auto' || mode === 'apify') {
    attemptedProviders.push('apify')
    const apifyTranscript = await fetchTranscriptWithApify(
      options.fetch,
      options.apifyApiToken,
      url
    )
    if (apifyTranscript) {
      return {
        text: normalizeTranscriptText(apifyTranscript),
        source: 'apify',
        metadata: { provider: 'apify' },
        attemptedProviders,
      }
    }
  }

  // Try yt-dlp (audio download + OpenAI/FAL transcription) if mode is 'auto' or 'yt-dlp'
  if (mode === 'yt-dlp' || (mode === 'auto' && canRunYtDlp)) {
    attemptedProviders.push('yt-dlp')
    const ytdlpResult = await fetchTranscriptWithYtDlp({
      ytDlpPath: options.ytDlpPath,
      openaiApiKey: options.openaiApiKey,
      falApiKey: options.falApiKey,
      url,
    })
    if (ytdlpResult.notes.length > 0) {
      notes.push(...ytdlpResult.notes)
    }
    if (ytdlpResult.text) {
      return {
        text: normalizeTranscriptText(ytdlpResult.text),
        source: 'yt-dlp',
        metadata: { provider: 'yt-dlp', transcriptionProvider: ytdlpResult.provider },
        attemptedProviders,
        notes: notes.length > 0 ? notes.join('; ') : null,
      }
    }
    if (mode === 'yt-dlp' && ytdlpResult.error) {
      throw ytdlpResult.error
    }
  }

  attemptedProviders.push('unavailable')
  return {
    text: null,
    source: 'unavailable',
    metadata: { provider: 'youtube', reason: 'no_transcript_available' },
    attemptedProviders,
    notes: notes.length > 0 ? notes.join('; ') : null,
  }
}
