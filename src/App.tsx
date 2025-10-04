import { useEffect, useRef, useState } from 'react'
import './App.css'
import type { AggregatesResult } from './types'
import { BarChart, Matrix } from './components/Charts'
import { solverLabel } from './utils/solvers'

function App() {
  const [data, setData] = useState<AggregatesResult | null>(null)
  const baseDataRef = useRef<AggregatesResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<number>(0)
  const workerRef = useRef<Worker | null>(null)
  // index cache no longer used; worker holds index in memory

  // filters
  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('')
  const [direction, setDirection] = useState<'ALL' | 'USDC_to_WBTC' | 'WBTC_to_USDC'>('ALL')
  const [minNotional, setMinNotional] = useState<string>('')
  const [maxNotional, setMaxNotional] = useState<string>('')

  useEffect(() => {
    // Kick off aggregation on mount
    const w = new Worker(new URL('./workers/aggregate.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = w
    w.onmessage = (ev: MessageEvent<{ type: 'progress' | 'done' | 'error' | 'filtered'; loaded?: number; data?: AggregatesResult; error?: string }>) => {
      if (ev.data.type === 'progress') {
        setProgress(ev.data.loaded ?? 0)
      } else if (ev.data.type === 'done') {
        if (ev.data.data) {
          setData(ev.data.data)
          baseDataRef.current = ev.data.data
        }
      } else if (ev.data.type === 'error') {
        setError(ev.data.error ?? 'Unknown error')
      } else if (ev.data.type === 'filtered') {
        if (ev.data.data) setData(ev.data.data)
      }
    }
    // Use relative path first; provide optional external URL as fallback via ?dataUrl= query
    const params = new URLSearchParams(location.search)
    const altFileUrl = params.get('dataUrl') || undefined
    w.postMessage({ type: 'aggregate', filePath: '/data/usdc-wbtc-trades.enriched-prices9.json', altFileUrl })
    return () => { w.terminate() }
  }, [])

  useEffect(() => {
    // no-op: index is held in worker after initial aggregation
  }, [])

  const applyFilters = () => {
    const fromTs = from ? Math.floor(new Date(from).getTime() / 1000) : undefined
    const toTs = to ? Math.floor(new Date(to).getTime() / 1000) : undefined
    const minN = minNotional ? Number(minNotional) : undefined
    const maxN = maxNotional ? Number(maxNotional) : undefined
    const noFilters = !fromTs && !toTs && minN == null && maxN == null && direction === 'ALL'
    if (noFilters && baseDataRef.current) {
      setData(baseDataRef.current)
      return
    }
    workerRef.current?.postMessage({ type: 'filter', criteria: { fromTs, toTs, direction, minNotional: minN, maxNotional: maxN } })
  }

  // const totalMB = 0 // unknown without content-length; keep 0
  const hasData = !!data

  return (
    <div className="app">
      <div className="container">
        <h1>Mainnet Analytics</h1>
        {!hasData && !error && (
          <div className="panel" style={{ marginTop: 16 }}>
            <div className="muted">Parsing data… This may take a moment.</div>
            <div className="progress" style={{ marginTop: 8 }}><div style={{ width: progress ? '20%' : '5%' }} /></div>
            <div className="muted" style={{ marginTop: 8 }}>
              Serving from <code>data/usdc-wbtc-trades.enriched-prices9.json</code>. To provide a remote URL fallback, open with <code>?dataUrl=https://example.com/file.json</code>.
            </div>
          </div>
        )}
        {error && (
          <div className="panel" style={{ marginTop: 16 }}>
            <div>Failed to load dataset.</div>
            <div className="muted">{error}</div>
            <div className="muted" style={{ marginTop: 8 }}>
              Ensure the file exists at <code>public/data/usdc-wbtc-trades.enriched-prices9.json</code> or configure a path.
            </div>
          </div>
        )}

        {hasData && data && (
          <>
            <div className="panel" style={{ marginTop: 16 }}>
              <h3>Filters</h3>
              <div className="controls">
                <label>From <input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} /></label>
                <label>To <input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} /></label>
                <label>Direction
                  <select value={direction} onChange={e => setDirection(e.target.value as 'ALL' | 'USDC_to_WBTC' | 'WBTC_to_USDC')}>
                    <option value="ALL">ALL</option>
                    <option value="USDC_to_WBTC">USDC_to_WBTC</option>
                    <option value="WBTC_to_USDC">WBTC_to_USDC</option>
                  </select>
                </label>
                <label>Min Notional (USDC) <input type="number" placeholder="e.g. 100000" value={minNotional} onChange={e => setMinNotional(e.target.value)} /></label>
                <label>Max Notional (USDC) <input type="number" placeholder="e.g. 10000000" value={maxNotional} onChange={e => setMaxNotional(e.target.value)} /></label>
                <button onClick={applyFilters}>Apply</button>
              </div>
            </div>
            <div className="grid" style={{ marginTop: 16 }}>
              <div className="panel kpi">
                <h3>Total Trades</h3>
                <div className="val">{data.totalTrades.toLocaleString()}</div>
              </div>
              <div className="panel kpi">
                <h3>Total Notional (USDC)</h3>
                <div className="val">{Math.round(data.totalNotionalUSDC).toLocaleString()}</div>
              </div>
              <div className="panel kpi">
                <h3>Avg Participants</h3>
                <div className="val">{data.avgParticipants.toFixed(2)}</div>
              </div>
              <div className="panel kpi">
                <h3>Single-bid Share</h3>
                <div className="val">{(data.singleBidShare * 100).toFixed(1)}%</div>
              </div>
            </div>

            <div className="panel" style={{ marginTop: 16 }}>
              <h3>Top Solvers</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Solver</th>
                    <th>Wins</th>
                    <th>Participations</th>
                    <th>Volume (USDC)</th>
                    <th>Win Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.solverStats.slice(0, 20).map(s => (
                    <tr key={s.solverAddress}>
                      <td><code title={s.solverAddress}>{solverLabel(s.solverAddress)}</code></td>
                      <td>{s.wins}</td>
                      <td>{s.tradesParticipated}</td>
                      <td>{Math.round(s.volumeUSDC).toLocaleString()}</td>
                      <td>{(s.wins / Math.max(1, s.tradesParticipated) * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid" style={{ marginTop: 16 }}>
              <div className="panel" style={{ gridColumn: 'span 6' }}>
                <h3>Participation Distribution</h3>
                {data.participationStats && (
                  <div className="muted" style={{ marginBottom: 8 }}>
                    <span title="Number of trades included after filters">n={data.participationStats.count}</span>
                    <span style={{ margin: '0 6px' }}>•</span>
                    <span title="Arithmetic mean participants per trade">avg={data.participationStats.avg.toFixed(2)}</span>
                    <span style={{ margin: '0 6px' }}>•</span>
                    <span title="Median (50th percentile) participants">p50={data.participationStats.p50.toFixed(0)}</span>
                    <span style={{ margin: '0 6px' }}>•</span>
                    <span title="25th percentile participants">p25={data.participationStats.p25.toFixed(0)}</span>
                    <span style={{ margin: '0 6px' }}>•</span>
                    <span title="75th percentile participants">p75={data.participationStats.p75.toFixed(0)}</span>
                  </div>
                )}
                <BarChart data={data.participationHistogram} xKey="bucket" yKey="count" yLabel="trades" />
              </div>
              <div className="panel" style={{ gridColumn: 'span 6' }}>
                <h3>Winner Margin Distribution (%)</h3>
                {data.marginStats && (
                  <div className="muted" style={{ marginBottom: 8 }}>
                    <span title="Number of trades with computable winner vs block margin">n={data.marginStats.count}</span>
                    <span style={{ margin: '0 6px' }}>•</span>
                    <span title="Average percent difference: (winner USDC/BTC − block USDC/BTC) / block">avg={data.marginStats.avgPct.toFixed(2)}%</span>
                    <span style={{ margin: '0 6px' }}>•</span>
                    <span title="Median percent difference (50th percentile)">p50={data.marginStats.p50Pct.toFixed(2)}%</span>
                    <span style={{ margin: '0 6px' }}>•</span>
                    <span title="25th percentile percent difference">p25={data.marginStats.p25Pct.toFixed(2)}%</span>
                    <span style={{ margin: '0 6px' }}>•</span>
                    <span title="75th percentile percent difference">p75={data.marginStats.p75Pct.toFixed(2)}%</span>
                  </div>
                )}
                <BarChart data={data.marginHistogram} xKey="bucket" yKey="count" yLabel="trades" />
              </div>
            </div>

            {data.rivalryMatrix && (
              <div className="panel" style={{ marginTop: 16 }}>
                <h3>Rivalry Matrix (row win rate vs col)</h3>
                <Matrix labels={data.rivalryMatrix.solvers.map(solverLabel)} matrix={data.rivalryMatrix.matrix} />
              </div>
            )}

            {data.topSolverAnalytics && data.topSolverAnalytics.length > 0 && (
              <div className="panel" style={{ marginTop: 16 }}>
                <h3>Top 5 Solver Analytics</h3>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Solver</th>
                      <th>Wins</th>
                      <th>Win rate</th>
                      <th>Volume (USDC)</th>
                      <th>Avg win margin</th>
                      <th>P50 win margin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topSolverAnalytics.map(s => (
                      <tr key={s.solverAddress}>
                        <td><code title={s.solverAddress}>{solverLabel(s.solverAddress)}</code></td>
                        <td>{s.wins}</td>
                        <td>{(s.winRate * 100).toFixed(1)}%</td>
                        <td>{Math.round(s.volumeUSDC).toLocaleString()}</td>
                        <td>{s.avgWinMarginPct != null ? s.avgWinMarginPct.toFixed(2) + '%' : '-'}</td>
                        <td>{s.p50WinMarginPct != null ? s.p50WinMarginPct.toFixed(2) + '%' : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Recent Trades section removed per request */}
          </>
        )}
      </div>
    </div>
  )
}

export default App
