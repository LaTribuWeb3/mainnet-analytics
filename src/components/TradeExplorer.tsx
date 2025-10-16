import { useMemo, useState } from 'react'
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
      <div className="mb-2 flex items-center gap-2">
        <input placeholder="Search orderUid or winner…" value={query} onChange={e => setQuery(e.target.value)} className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-slate-200" />
        <div className="text-slate-400">{filtered.length} rows</div>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-left">
            <th className="border-b border-slate-800 px-3 py-2">Time</th>
            <th className="border-b border-slate-800 px-3 py-2">Order</th>
            <th className="border-b border-slate-800 px-3 py-2">Dir</th>
            <th className="border-b border-slate-800 px-3 py-2">Notional</th>
            <th className="border-b border-slate-800 px-3 py-2">Participants</th>
            <th className="border-b border-slate-800 px-3 py-2">Winner</th>
            <th className="border-b border-slate-800 px-3 py-2">Margin</th>
            <th className="border-b border-slate-800 px-3 py-2">Top solutions (p USDC/BTC)</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map(t => (
            <tr key={t.orderUid}>
              <td className="border-b border-slate-800 px-3 py-2">{new Date(t.timestamp * 1000).toISOString().replace('T',' ').slice(0,16)}</td>
              <td className="border-b border-slate-800 px-3 py-2"><code>{t.orderUid.slice(0,10)}…</code></td>
              <td className="border-b border-slate-800 px-3 py-2">{t.direction}</td>
              <td className="border-b border-slate-800 px-3 py-2">{Math.round(t.notionalUSDC).toLocaleString()}</td>
              <td className="border-b border-slate-800 px-3 py-2">{t.participants}</td>
              <td className="border-b border-slate-800 px-3 py-2"><code title={t.winner}>{solverLabel(t.winner)}</code></td>
              <td className="border-b border-slate-800 px-3 py-2">{t.priceMarginPct != null ? (t.priceMarginPct * 100).toFixed(3) + '%' : '-'}</td>
              <td className="border-b border-slate-800 px-3 py-2">
                {t.topSolutions?.map(s => (
                  <span key={`${t.orderUid}-${s.solver}-${s.rank}`} title={s.solver} className="mr-2">
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


