import React from 'react'

export function BarChart({ data, xKey, yKey, height = 180, yLabel }: { data: Array<Record<string, any>>; xKey: string; yKey: string; height?: number; yLabel?: string }) {
  const max = Math.max(1, ...data.map(d => Number(d[yKey]) || 0))
  const barW = Math.max(16, Math.min(48, Math.floor(700 / Math.max(1, data.length))))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `24px 1fr`, gap: 8 }}>
      <div style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', color: '#9ca3af', fontSize: 12, alignSelf: 'center' }}>{yLabel || 'count'}</div>
      <div style={{ display: 'flex', alignItems: 'end', gap: 8, height }}>
        {data.map((d, i) => {
          const v = Number(d[yKey]) || 0
          const h = Math.round((v / max) * (height - 24))
          return (
            <div key={i} title={`${d[xKey]}: ${v}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ width: barW, height: h, background: 'linear-gradient(180deg,#7ab8ff,#4f86e6)', borderRadius: 6 }} />
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6, transform: 'rotate(45deg)', transformOrigin: 'top left' }}>{String(d[xKey])}</div>
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
    <svg width="100%" height={height} viewBox={`0 0 ${points.length || 1} ${range}`} preserveAspectRatio="none" style={{ background: '#0f172a', borderRadius: 8 }}>
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
  const size = labels.length
  return (
    <table className="table">
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


