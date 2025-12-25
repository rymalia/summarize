import type { ModelConfig, SummarizeConfig } from '../config.js'
import type { RequestedModel } from '../model-spec.js'
import { parseRequestedModelId } from '../model-spec.js'
import { BUILTIN_MODELS } from './constants.js'

export type ModelSelection = {
  requestedModel: RequestedModel
  requestedModelInput: string
  requestedModelLabel: string
  isNamedModelSelection: boolean
  wantsFreeNamedModel: boolean
  configForModelSelection: SummarizeConfig | null
  isFallbackModel: boolean
}

export function resolveModelSelection({
  config,
  configForCli,
  configPath,
  envForRun,
  explicitModelArg,
}: {
  config: SummarizeConfig | null
  configForCli: SummarizeConfig | null
  configPath: string | null
  envForRun: Record<string, string | undefined>
  explicitModelArg: string | null
}): ModelSelection {
  const modelMap = (() => {
    const out = new Map<string, { name: string; model: ModelConfig }>()

    for (const [name, model] of Object.entries(BUILTIN_MODELS)) {
      out.set(name.toLowerCase(), { name, model })
    }

    const raw = config?.models
    if (!raw) return out
    for (const [name, model] of Object.entries(raw)) {
      out.set(name.toLowerCase(), { name, model })
    }
    return out
  })()

  const resolvedDefaultModel = (() => {
    if (
      typeof envForRun.SUMMARIZE_MODEL === 'string' &&
      envForRun.SUMMARIZE_MODEL.trim().length > 0
    ) {
      return envForRun.SUMMARIZE_MODEL.trim()
    }
    const modelFromConfig = config?.model
    if (modelFromConfig) {
      if ('id' in modelFromConfig && typeof modelFromConfig.id === 'string') {
        const id = modelFromConfig.id.trim()
        if (id.length > 0) return id
      }
      if ('name' in modelFromConfig && typeof modelFromConfig.name === 'string') {
        const name = modelFromConfig.name.trim()
        if (name.length > 0) return name
      }
      if ('mode' in modelFromConfig && modelFromConfig.mode === 'auto') return 'auto'
    }
    return 'auto'
  })()

  const requestedModelInput = ((explicitModelArg?.trim() ?? '') || resolvedDefaultModel).trim()
  const requestedModelInputLower = requestedModelInput.toLowerCase()
  const wantsFreeNamedModel = requestedModelInputLower === 'free'

  const namedModelMatch =
    requestedModelInputLower !== 'auto' ? (modelMap.get(requestedModelInputLower) ?? null) : null
  const namedModelConfig = namedModelMatch?.model ?? null
  const isNamedModelSelection = Boolean(namedModelMatch)

  const configForModelSelection =
    isNamedModelSelection && namedModelConfig
      ? ({ ...(configForCli ?? {}), model: namedModelConfig } as const)
      : configForCli

  const requestedModel: RequestedModel = (() => {
    if (isNamedModelSelection && namedModelConfig) {
      if ('id' in namedModelConfig) return parseRequestedModelId(namedModelConfig.id)
      if ('mode' in namedModelConfig && namedModelConfig.mode === 'auto') return { kind: 'auto' }
      throw new Error(
        `Invalid model "${namedModelMatch?.name ?? requestedModelInput}": unsupported model config`
      )
    }

    if (requestedModelInputLower !== 'auto' && !requestedModelInput.includes('/')) {
      throw new Error(
        `Unknown model "${requestedModelInput}". Define it in ${configPath ?? '~/.summarize/config.json'} under "models", or use a provider-prefixed id like openai/...`
      )
    }

    return parseRequestedModelId(requestedModelInput)
  })()

  const requestedModelLabel = isNamedModelSelection
    ? requestedModelInput
    : requestedModel.kind === 'auto'
      ? 'auto'
      : requestedModel.userModelId

  const isFallbackModel = requestedModel.kind === 'auto'

  return {
    requestedModel,
    requestedModelInput,
    requestedModelLabel,
    isNamedModelSelection,
    wantsFreeNamedModel,
    configForModelSelection,
    isFallbackModel,
  }
}
