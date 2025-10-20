import { useEffect, useRef, useState } from 'react'
import { formatUSDCCompact } from '../utils/format'

export function BarChart({ data, xKey, yKey, height = 180, yLabel, labelFormatter }: { data: Array<Record<string, unknown>>; xKey: string; yKey: string; height?: number; yLabel?: string; labelFormatter?: (s: string) => string }) {
  const max = Math.max(1, ...data.map(d => Number(d[yKey]) || 0))
  const barsRef = useRef<HTMLDivElement | null>(null)
  const [containerW, setContainerW] = useState<number>(600)
  useEffect(() => {
    const el = barsRef.current
    if (!el) return
    const update = () => setContainerW(el.clientWidth)
    update()
    const ro = new ResizeObserver(() => update())
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => { ro.disconnect(); window.removeEventListener('resize', update) }
  }, [])
  const gap = 8
  const barW = Math.max(12, Math.floor((containerW - gap * Math.max(0, data.length - 1)) / Math.max(1, data.length)))
  const ticks = (() => {
    const steps = 4
    return Array.from({ length: steps + 1 }, (_, i) => Math.round((max * i) / steps))
  })()
  return (
    <div className="grid grid-cols-[48px_1fr] gap-2">
      <div className="relative" style={{ height }}>
        <div className="absolute top-0 left-0 text-xs text-slate-400">{yLabel || 'count'}</div>
        {ticks.map((t, i) => {
          const y = Math.round(((height - 24) * (1 - (t / max))))
          return (
            <div key={i} className="absolute text-[10px] text-slate-400" style={{ top: y, right: 0, transform: 'translateY(50%)' }}>{t}</div>
          )
        })}
      </div>
      <div ref={barsRef} className="relative flex items-end w-full overflow-x-hidden overflow-y-visible" style={{ gap, height }}>
        {/* horizontal grid lines */}
        {ticks.map((t, i) => {
          const y = Math.round(((height - 24) * (1 - (t / max))))
          return (
            <div key={`grid-${i}`} className="absolute left-0 right-0" style={{ top: y, height: 1, background: 'rgba(148,163,184,0.2)' }} />
          )
        })}
        {data.map((d, i) => {
          const v = Number(d[yKey]) || 0
          const rawH = (v / max) * (height - 24)
          const h = v > 0 ? Math.max(1, Math.round(rawH)) : 0
          return (
            <div key={i} title={`${d[xKey]}: ${v}`} className="flex flex-col items-center">
              <div style={{ width: barW, height: h, background: 'linear-gradient(180deg,#7ab8ff,#4f86e6)', position: 'relative', zIndex: 1 }} className="rounded-md" />
              <div className="mt-1 w-full text-center text-[11px] text-slate-400 whitespace-nowrap overflow-hidden text-ellipsis" style={{ width: barW }}>
                {labelFormatter ? labelFormatter(String(d[xKey])) : String(d[xKey])}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function LineChart({ points, height = 160 }: { points: Array<{ x: string; y: number }>; height?: number }) {
  const max = Math.max(1, ...points.map(p => p.y))
  const min = Math.min(0, ...points.map(p => p.y))
  const range = Math.max(1, max - min)
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${points.length || 1} ${range}`} preserveAspectRatio="none" className="rounded-lg" style={{ background: '#0f172a' }}>
      <polyline
        fill="none"
        stroke="#60a5fa"
        strokeWidth="0.5"
        points={points.map((p, i) => `${i},${(max - p.y)}`).join(' ')}
      />
    </svg>
  )
}

export function Matrix({ labels, matrix }: { labels: string[]; matrix: number[][] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          <th>Solver</th>
          {labels.map(l => <th key={l}><code>{l.slice(0,8)}</code></th>)}
        </tr>
      </thead>
      <tbody>
        {labels.map((row, i) => (
          <tr key={row}>
            <td><code>{row}</code></td>
            {labels.map((col, j) => (
              <td key={col} style={{ background: i===j ? 'transparent' : 'rgba(96,165,250,' + (matrix[i]?.[j] || 0) + ')'}}>{i===j ? '-' : ((matrix[i]?.[j]||0)*100).toFixed(0)}%</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function PieChart({ data, labelKey, valueKey, size = 220 }: { data: Array<Record<string, unknown>>; labelKey: string; valueKey: string; size?: number }) {
  const radius = size / 2
  const total = data.reduce((a, d) => a + (Number(d[valueKey]) || 0), 0)
  const toUpperBoundLabel = (bucket: string): string => {
    if (!bucket) return bucket
    if (bucket.endsWith('+')) {
      const base = Number(bucket.slice(0, -1))
      if (isFinite(base)) return `$${formatUSDCCompact(base)}+`
      return bucket
    }
    const parts = bucket.split('..')
    if (parts.length === 2) {
      const hi = Number(parts[1])
      if (isFinite(hi)) return `$${formatUSDCCompact(hi)}`
    }
    return bucket
  }
  let angle = -Math.PI / 2
  const slices = data.map((d, i) => {
    const value = Number(d[valueKey]) || 0
    const pct = total > 0 ? value / total : 0
    const sweep = pct * Math.PI * 2
    const x1 = radius + radius * Math.cos(angle)
    const y1 = radius + radius * Math.sin(angle)
    const x2 = radius + radius * Math.cos(angle + sweep)
    const y2 = radius + radius * Math.sin(angle + sweep)
    const largeArc = sweep > Math.PI ? 1 : 0
    const path = `M ${radius} ${radius} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`
    angle += sweep
    const hue = (i * 47) % 360
    const rawLabel = String(d[labelKey])
    const displayLabel = toUpperBoundLabel(rawLabel)
    return { path, color: `hsl(${hue} 70% 50%)`, label: displayLabel, value, pct }
  })
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ background: '#0f172a', borderRadius: 8 }}>
        {slices.map((s, i) => (
          <path key={i} d={s.path} fill={s.color}>
            <title>{`${s.label} • ${((s.pct || 0) * 100).toFixed(1)}% • $${formatUSDCCompact(s.value)}`}</title>
          </path>
        ))}
      </svg>
      <div>
        {slices.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <div style={{ width: 12, height: 12, background: s.color, borderRadius: 2 }} />
            <div style={{ color: '#e5e7eb' }}>{s.label}</div>
            <div className="muted">{total > 0 ? ((s.pct * 100).toFixed(1) + '%') : '-'}</div>
          </div>
        ))}
      </div>
    </div>
  )
}


