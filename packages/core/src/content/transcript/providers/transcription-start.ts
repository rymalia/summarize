import { isOnnxCliConfigured, resolvePreferredOnnxModel } from '../../../transcription/onnx-cli.js'
import {
  isWhisperCppReady,
  resolveWhisperCppModelNameForDisplay,
} from '../../../transcription/whisper.js'
import type { TranscriptionProviderHint } from '../../link-preview/deps.js'

type Env = Record<string, string | undefined>

export type TranscriptionAvailability = {
  preferredOnnxModel: ReturnType<typeof resolvePreferredOnnxModel>
  onnxReady: boolean
  hasLocalWhisper: boolean
  hasOpenai: boolean
  hasFal: boolean
  hasAnyProvider: boolean
}

export async function resolveTranscriptionAvailability({
  env,
  openaiApiKey,
  falApiKey,
}: {
  env?: Env
  openaiApiKey: string | null
  falApiKey: string | null
}): Promise<TranscriptionAvailability> {
  const effectiveEnv = env ?? process.env
  const preferredOnnxModel = resolvePreferredOnnxModel(effectiveEnv)
  const onnxReady = preferredOnnxModel
    ? isOnnxCliConfigured(preferredOnnxModel, effectiveEnv)
    : false

  const hasLocalWhisper = await isWhisperCppReady()
  const hasOpenai = Boolean(openaiApiKey)
  const hasFal = Boolean(falApiKey)
  const hasAnyProvider = onnxReady || hasLocalWhisper || hasOpenai || hasFal

  return {
    preferredOnnxModel,
    onnxReady,
    hasLocalWhisper,
    hasOpenai,
    hasFal,
    hasAnyProvider,
  }
}

export async function resolveTranscriptionStartInfo({
  env,
  openaiApiKey,
  falApiKey,
}: {
  env?: Env
  openaiApiKey: string | null
  falApiKey: string | null
}): Promise<{
  availability: TranscriptionAvailability
  providerHint: TranscriptionProviderHint
  modelId: string | null
}> {
  const availability = await resolveTranscriptionAvailability({ env, openaiApiKey, falApiKey })

  const providerHint: TranscriptionProviderHint = availability.onnxReady
    ? 'onnx'
    : availability.hasLocalWhisper
      ? 'cpp'
      : availability.hasOpenai && availability.hasFal
        ? 'openai->fal'
        : availability.hasOpenai
          ? 'openai'
          : availability.hasFal
            ? 'fal'
            : 'unknown'

  const modelId =
    providerHint === 'onnx'
      ? availability.preferredOnnxModel
        ? `onnx/${availability.preferredOnnxModel}`
        : 'onnx'
      : providerHint === 'cpp'
        ? ((await resolveWhisperCppModelNameForDisplay()) ?? 'whisper.cpp')
        : availability.hasOpenai && availability.hasFal
          ? 'whisper-1->fal-ai/wizper'
          : availability.hasOpenai
            ? 'whisper-1'
            : availability.hasFal
              ? 'fal-ai/wizper'
              : null

  return { availability, providerHint, modelId }
}
