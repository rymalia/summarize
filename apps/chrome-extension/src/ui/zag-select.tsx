import { normalizeProps, useMachine } from '@zag-js/preact'
import * as select from '@zag-js/select'
import { useEffect, useMemo, useRef } from 'preact/hooks'

export type SelectItem = {
  label: string
  value: string
  disabled?: boolean
}

type UseZagSelectArgs = {
  id: string
  items: SelectItem[]
  value: string
  onValueChange: (value: string) => void
}

export function useZagSelect({ id, items, value, onValueChange }: UseZagSelectArgs) {
  const collection = useMemo(
    () =>
      select.collection({
        items,
        itemToValue: (item) => item.value,
        itemToString: (item) => item.label,
        isItemDisabled: (item) => Boolean(item.disabled),
      }),
    [items]
  )

  const syncing = useRef(false)

  const [state, send] = useMachine(
    select.machine({
      id,
      collection,
      positioning: { placement: 'bottom-start', gutter: 6, sameWidth: true },
      defaultValue: value ? [value] : [],
      onValueChange: ({ value: next }: select.ValueChangeDetails) => {
        if (syncing.current) return
        onValueChange(next[0] ?? '')
      },
    })
  )

  const api = select.connect(state, send, normalizeProps)
  const apiRef = useRef(api)
  apiRef.current = api

  useEffect(() => {
    const nextValue = value ? [value] : []
    const current = apiRef.current.value[0] ?? ''
    if (current === (nextValue[0] ?? '')) return
    syncing.current = true
    apiRef.current.setValue(nextValue)
    queueMicrotask(() => {
      syncing.current = false
    })
  }, [value])

  return api
}
