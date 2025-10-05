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

