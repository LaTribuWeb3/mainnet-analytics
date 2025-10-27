export function formatUSDCCompact(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(abs >= 1e13 ? 0 : 1) + 'T'
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B'
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M'
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'K'
  return sign + Math.round(abs).toString()
}

export function formatRangeBucketLabel(label: string): string {
  if (label.endsWith('+')) {
    const base = Number(label.slice(0, -1))
    if (isFinite(base)) return formatUSDCCompact(base) + '+'
    return label
  }
  const [a, b] = label.split('..')
  const na = Number(a)
  const nb = Number(b)
  if (isFinite(na) && isFinite(nb)) return `${formatUSDCCompact(na)}..${formatUSDCCompact(nb)}`
  return label
}

// Truncate a number to fixed decimal places without rounding
export function truncateToDecimals(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '-'
  const factor = 10 ** decimals
  const truncated = Math.trunc(value * factor) / factor
  return truncated.toFixed(decimals)
}

export function truncateNumber(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.trunc(value * factor) / factor
}

export function formatCompactTruncate(value: number, decimals = 2): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  let unit = ''
  let scaled = abs
  if (abs >= 1e12) {
    unit = 'T'
    scaled = abs / 1e12
  } else if (abs >= 1e9) {
    unit = 'B'
    scaled = abs / 1e9
  } else if (abs >= 1e6) {
    unit = 'M'
    scaled = abs / 1e6
  } else if (abs >= 1e3) {
    unit = 'K'
    scaled = abs / 1e3
  }
  const truncated = truncateNumber(scaled, decimals)
  const s = truncated.toFixed(decimals).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1')
  return sign + s + unit
}

