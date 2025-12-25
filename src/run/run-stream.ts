import type { RenderMode, StreamMode } from '../flags.js'
import { isRichTty } from './terminal.js'

export type StreamSettings = {
  effectiveStreamMode: 'on' | 'off'
  streamingEnabled: boolean
  effectiveRenderMode: 'md' | 'md-live' | 'plain'
}

export function resolveStreamSettings({
  streamMode,
  renderMode,
  stdout,
  json,
  extractMode,
}: {
  streamMode: StreamMode
  renderMode: RenderMode
  stdout: NodeJS.WritableStream
  json: boolean
  extractMode: boolean
}): StreamSettings {
  const effectiveStreamMode = (() => {
    if (streamMode !== 'auto') return streamMode
    return isRichTty(stdout) ? 'on' : 'off'
  })()
  const streamingEnabled = effectiveStreamMode === 'on' && !json && !extractMode
  const effectiveRenderMode = (() => {
    if (renderMode !== 'auto') return renderMode
    if (!isRichTty(stdout)) return 'plain'
    return streamingEnabled ? 'md-live' : 'md'
  })()

  return { effectiveStreamMode, streamingEnabled, effectiveRenderMode }
}
