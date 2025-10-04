import React, { useMemo, useState } from 'react'
import type { AggregatesResult } from '../types'
import { solverLabel } from '../utils/solvers'

export function TradeExplorer({ data }: { data: AggregatesResult }) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return data.tradesPreview
    return data.tradesPreview.filter(t => t.orderUid.toLowerCase().includes(q) || t.winner.toLowerCase().includes(q))
  }, [data, query])
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input placeholder="Search orderUid or winner…" value={query} onChange={e => setQuery(e.target.value)} style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #1f2937', background: '#0f172a', color: '#e5e7eb' }} />
        <div className="muted">{filtered.length} rows</div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Order</th>
            <th>Dir</th>
            <th>Notional</th>
            <th>Participants</th>
            <th>Winner</th>
            <th>Margin</th>
            <th>Top solutions (p USDC/BTC)</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(t => (
            <tr key={t.orderUid}>
              <td>{new Date(t.timestamp * 1000).toISOString().replace('T',' ').slice(0,16)}</td>
              <td><code>{t.orderUid.slice(0,10)}…</code></td>
              <td>{t.direction}</td>
              <td>{Math.round(t.notionalUSDC).toLocaleString()}</td>
              <td>{t.participants}</td>
              <td><code title={t.winner}>{solverLabel(t.winner)}</code></td>
              <td>{t.priceMarginPct != null ? (t.priceMarginPct * 100).toFixed(3) + '%' : '-'}</td>
              <td>
                {t.topSolutions?.map(s => (
                  <span key={`${t.orderUid}-${s.solver}-${s.rank}`} title={s.solver} style={{ marginRight: 8 }}>
                    <code>{solverLabel(s.solver)}</code>: {s.priceUSDCPerBTC != null ? s.priceUSDCPerBTC.toFixed(2) : '-'}
                  </span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}


