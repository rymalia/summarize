type ErrorControllerOptions = {
  panelEl: HTMLElement
  panelMessageEl: HTMLElement
  panelRetryBtn?: HTMLButtonElement | null
  panelLogsBtn?: HTMLButtonElement | null
  inlineEl: HTMLElement
  inlineMessageEl: HTMLElement
  inlineRetryBtn?: HTMLButtonElement | null
  inlineLogsBtn?: HTMLButtonElement | null
  inlineCloseBtn?: HTMLButtonElement | null
  onRetry?: () => void
  onOpenLogs?: () => void
  onPanelVisibilityChange?: () => void
}

export type ErrorController = {
  showPanelError: (message: string) => void
  showInlineError: (message: string) => void
  clearPanelError: () => void
  clearInlineError: () => void
  clearAll: () => void
}

const normalizeMessage = (message: string) => {
  const trimmed = message.trim()
  return trimmed.length > 0 ? trimmed : 'Something went wrong.'
}

export const createErrorController = (options: ErrorControllerOptions): ErrorController => {
  const {
    panelEl,
    panelMessageEl,
    panelRetryBtn,
    panelLogsBtn,
    inlineEl,
    inlineMessageEl,
    inlineRetryBtn,
    inlineLogsBtn,
    inlineCloseBtn,
    onRetry,
    onOpenLogs,
    onPanelVisibilityChange,
  } = options

  const hideInline = () => {
    inlineMessageEl.textContent = ''
    inlineEl.classList.add('hidden')
    inlineEl.style.display = 'none'
  }

  const hidePanel = () => {
    panelMessageEl.textContent = ''
    panelEl.classList.add('hidden')
    onPanelVisibilityChange?.()
  }

  const showPanel = (message: string) => {
    const trimmed = message.trim()
    if (!trimmed) {
      hidePanel()
      return
    }
    hideInline()
    panelMessageEl.textContent = normalizeMessage(message)
    panelEl.classList.remove('hidden')
    onPanelVisibilityChange?.()
  }

  const showInline = (message: string) => {
    const trimmed = message.trim()
    if (!trimmed) {
      hideInline()
      return
    }
    hidePanel()
    inlineMessageEl.textContent = normalizeMessage(message)
    inlineEl.classList.remove('hidden')
    inlineEl.style.display = ''
  }

  panelRetryBtn?.addEventListener('click', () => onRetry?.())
  panelLogsBtn?.addEventListener('click', () => onOpenLogs?.())
  inlineRetryBtn?.addEventListener('click', () => onRetry?.())
  inlineLogsBtn?.addEventListener('click', () => onOpenLogs?.())
  inlineCloseBtn?.addEventListener('click', () => hideInline())

  return {
    showPanelError: showPanel,
    showInlineError: showInline,
    clearPanelError: hidePanel,
    clearInlineError: hideInline,
    clearAll: () => {
      hidePanel()
      hideInline()
    },
  }
}
