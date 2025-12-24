export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown'

  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  if (totalSeconds < 10) return `${(ms / 1000).toFixed(1)}s`
  if (totalSeconds < 60) return `${totalSeconds}s`

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  const rounded = Math.floor(bytes)
  if (rounded < 1024) return `${rounded} B`

  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = rounded / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

export function formatBytesPerSecond(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return 'unknown'
  return `${formatBytes(Math.round(bytesPerSecond))}/s`
}

export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return 'unknown'
  const abs = Math.abs(value)
  const format = (n: number, suffix: string) => {
    const decimals = n >= 10 ? 0 : 1
    return `${n.toFixed(decimals)}${suffix}`
  }
  if (abs >= 1_000_000_000) return format(value / 1_000_000_000, 'B')
  if (abs >= 1_000_000) return format(value / 1_000_000, 'M')
  if (abs >= 10_000) return format(value / 1_000, 'k')
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.floor(value))
}

export function formatDurationSecondsSmart(value: number): string {
  if (!Number.isFinite(value)) return 'unknown'
  const totalSeconds = Math.max(0, Math.round(value))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`)
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`)
  return parts.join(' ')
}

