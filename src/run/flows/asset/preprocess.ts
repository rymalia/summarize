import type { ModelMessage } from 'ai'
import type { OutputLanguage } from '../../../language.js'
import { parseGatewayStyleModelId } from '../../../llm/model-id.js'
import { convertToMarkdownWithMarkitdown } from '../../../markitdown.js'
import type { FixedModelSpec } from '../../../model-spec.js'
import { buildFileSummaryPrompt, buildFileTextSummaryPrompt } from '../../../prompts/index.js'
import type { SummaryLength } from '../../../shared/contracts.js'
import { formatBytes } from '../../../tty/format.js'
import {
  type AssetAttachment,
  assertProviderSupportsAttachment,
  buildAssetPromptPayload,
  getFileBytesFromAttachment,
  getTextContentFromAttachment,
  shouldMarkitdownConvertMediaType,
} from '../../attachments.js'
import { MAX_TEXT_BYTES_DEFAULT } from '../../constants.js'
import { hasUvxCli } from '../../env.js'
import { withUvxTip } from '../../tips.js'

export type AssetPreprocessContext = {
  env: Record<string, string | undefined>
  envForRun: Record<string, string | undefined>
  execFileImpl: Parameters<typeof convertToMarkdownWithMarkitdown>[0]['execFileImpl']
  timeoutMs: number
  preprocessMode: 'off' | 'auto' | 'always'
  format: 'text' | 'markdown'
  lengthArg: { kind: 'preset'; preset: SummaryLength } | { kind: 'chars'; maxCharacters: number }
  outputLanguage: OutputLanguage
  fixedModelSpec: FixedModelSpec | null
}

export type AssetPreprocessResult = {
  promptPayload: string | Array<ModelMessage>
  promptText: string
  assetFooterParts: string[]
  textContent: { content: string; bytes: number } | null
}

export async function prepareAssetPrompt({
  ctx,
  attachment,
}: {
  ctx: AssetPreprocessContext
  attachment: AssetAttachment
}): Promise<AssetPreprocessResult> {
  const textContent = getTextContentFromAttachment(attachment)
  if (textContent && textContent.bytes > MAX_TEXT_BYTES_DEFAULT) {
    throw new Error(
      `Text file too large (${formatBytes(textContent.bytes)}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`
    )
  }

  const fileBytes = getFileBytesFromAttachment(attachment)
  const canPreprocessWithMarkitdown =
    ctx.format === 'markdown' &&
    ctx.preprocessMode !== 'off' &&
    hasUvxCli(ctx.env) &&
    attachment.part.type === 'file' &&
    fileBytes !== null &&
    shouldMarkitdownConvertMediaType(attachment.mediaType)

  const summaryLengthTarget =
    ctx.lengthArg.kind === 'preset'
      ? ctx.lengthArg.preset
      : { maxCharacters: ctx.lengthArg.maxCharacters }

  let promptText = ''
  const assetFooterParts: string[] = []

  const buildAttachmentPromptPayload = () => {
    promptText = buildFileSummaryPrompt({
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      summaryLength: summaryLengthTarget,
      contentLength: textContent?.content.length ?? null,
      outputLanguage: ctx.outputLanguage,
    })
    return buildAssetPromptPayload({ promptText, attachment, textContent })
  }

  const buildMarkitdownPromptPayload = (markdown: string) => {
    promptText = buildFileTextSummaryPrompt({
      filename: attachment.filename,
      originalMediaType: attachment.mediaType,
      contentMediaType: 'text/markdown',
      summaryLength: summaryLengthTarget,
      contentLength: markdown.length,
      outputLanguage: ctx.outputLanguage,
    })
    return `${promptText}\n\n---\n\n${markdown}`.trim()
  }

  let preprocessedMarkdown: string | null = null
  let usingPreprocessedMarkdown = false

  if (ctx.preprocessMode === 'always' && canPreprocessWithMarkitdown) {
    if (!fileBytes) {
      throw new Error('Internal error: missing file bytes for markitdown preprocessing')
    }
    try {
      preprocessedMarkdown = await convertToMarkdownWithMarkitdown({
        bytes: fileBytes,
        filenameHint: attachment.filename,
        mediaTypeHint: attachment.mediaType,
        uvxCommand: ctx.envForRun.UVX_PATH,
        timeoutMs: ctx.timeoutMs,
        env: ctx.env,
        execFileImpl: ctx.execFileImpl,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Failed to preprocess ${attachment.mediaType} with markitdown: ${message} (disable with --preprocess off).`
      )
    }
    if (Buffer.byteLength(preprocessedMarkdown, 'utf8') > MAX_TEXT_BYTES_DEFAULT) {
      throw new Error(
        `Preprocessed Markdown too large (${formatBytes(Buffer.byteLength(preprocessedMarkdown, 'utf8'))}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`
      )
    }
    usingPreprocessedMarkdown = true
    assetFooterParts.push(`markitdown(${attachment.mediaType})`)
  }

  let promptPayload: string | Array<ModelMessage> = buildAttachmentPromptPayload()
  if (usingPreprocessedMarkdown) {
    if (!preprocessedMarkdown) {
      throw new Error('Internal error: missing markitdown content for preprocessing')
    }
    promptPayload = buildMarkitdownPromptPayload(preprocessedMarkdown)
  }

  if (
    !usingPreprocessedMarkdown &&
    ctx.fixedModelSpec &&
    ctx.fixedModelSpec.transport !== 'cli' &&
    ctx.preprocessMode !== 'off'
  ) {
    const fixedParsed = parseGatewayStyleModelId(ctx.fixedModelSpec.llmModelId)
    try {
      assertProviderSupportsAttachment({
        provider: fixedParsed.provider,
        modelId: ctx.fixedModelSpec.userModelId,
        attachment: { part: attachment.part, mediaType: attachment.mediaType },
      })
    } catch (error) {
      if (!canPreprocessWithMarkitdown) {
        if (
          ctx.format === 'markdown' &&
          attachment.part.type === 'file' &&
          shouldMarkitdownConvertMediaType(attachment.mediaType) &&
          !hasUvxCli(ctx.env)
        ) {
          throw withUvxTip(error, ctx.env)
        }
        throw error
      }
      if (!fileBytes) {
        throw new Error('Internal error: missing file bytes for markitdown preprocessing')
      }
      try {
        preprocessedMarkdown = await convertToMarkdownWithMarkitdown({
          bytes: fileBytes,
          filenameHint: attachment.filename,
          mediaTypeHint: attachment.mediaType,
          uvxCommand: ctx.envForRun.UVX_PATH,
          timeoutMs: ctx.timeoutMs,
          env: ctx.env,
          execFileImpl: ctx.execFileImpl,
        })
      } catch (markitdownError) {
        if (ctx.preprocessMode === 'auto') {
          throw error
        }
        const message =
          markitdownError instanceof Error ? markitdownError.message : String(markitdownError)
        throw new Error(
          `Failed to preprocess ${attachment.mediaType} with markitdown: ${message} (disable with --preprocess off).`
        )
      }
      if (Buffer.byteLength(preprocessedMarkdown, 'utf8') > MAX_TEXT_BYTES_DEFAULT) {
        throw new Error(
          `Preprocessed Markdown too large (${formatBytes(Buffer.byteLength(preprocessedMarkdown, 'utf8'))}). Limit is ${formatBytes(MAX_TEXT_BYTES_DEFAULT)}.`
        )
      }
      usingPreprocessedMarkdown = true
      assetFooterParts.push(`markitdown(${attachment.mediaType})`)
      promptPayload = buildMarkitdownPromptPayload(preprocessedMarkdown)
    }
  }

  return { promptPayload, promptText, assetFooterParts, textContent }
}
