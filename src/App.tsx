import { useEffect, useRef, useState } from 'react'
import './App.css'
import type { AggregatesResult } from './types'
import { formatRangeBucketLabel, formatUSDCCompact } from './utils/format'
import { PieChart } from './components/Charts'
import { solverLabel } from './utils/solvers'

type PairKey = 'USDC-USDE' | 'USDC-USDT' | 'USDC-WBTC' | 'USDC-WETH'

type ApiDocument = {
  _id?: string
  txHash?: string
  orderUid?: string
  blockNumber?: number
  blockTimestamp?: number
  buyAmount?: string
  buyToken?: string
  sellAmount?: string
  sellToken?: string
  owner?: string
}

type ApiResponse = {
  collection: PairKey
  count: number
  documents: ApiDocument[]
}

function App() {
  const [selectedPair, setSelectedPair] = useState<PairKey>('USDC-USDE')
  const [activeView, setActiveView] = useState<'analytics' | 'solver'>('analytics')
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [apiData, setApiData] = useState<ApiResponse | null>(null)
  const [agg, setAgg] = useState<AggregatesResult | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const [fromTs, setFromTs] = useState<number | undefined>(undefined)
  const [toTs, setToTs] = useState<number | undefined>(undefined)
  // profits are computed without fees for now

  // Helpers for date handling (UTC day granularity)
  const tsToDay = (ts?: number) => ts ? new Date(ts * 1000).toISOString().slice(0, 10) : ''
  const parseDay = (day: string) => {
    const [y,m,d] = day.split('-').map(Number)
    return new Date(Date.UTC(y, (m||1)-1, d||1))
  }
  const dayStrToStartTs = (day: string) => Math.floor(parseDay(day).getTime() / 1000)
  const dayStrToEndTs = (day: string) => Math.floor((parseDay(day).getTime() + (24*60*60 - 1) * 1000) / 1000)

  useEffect(() => {
    const controller = new AbortController()
    const fetchData = async () => {
      setIsLoading(true)
      setError(null)
      try {
        const response = await fetch(`https://prod.mainnet.cowswap.la-tribu.xyz/db/${selectedPair}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`Failed to fetch ${selectedPair} (${response.status})`)
        const json = (await response.json()) as ApiResponse
        setApiData(json)
        // setup worker once
        if (!workerRef.current) {
          workerRef.current = new Worker(new URL('./workers/aggregate.worker.ts', import.meta.url), { type: 'module' })
          workerRef.current.onmessage = (ev: MessageEvent) => {
            const msg = ev.data as any
            if (msg?.type === 'done' || msg?.type === 'filtered') setAgg(msg.data as AggregatesResult)
            if (msg?.type === 'error') setError(String(msg.error || 'Worker error'))
          }
        }
        // aggregate from API directly (worker will fallback from local path if needed)
        workerRef.current!.postMessage({ type: 'aggregate', filePath: '/data/data.json', altFileUrl: `https://prod.mainnet.cowswap.la-tribu.xyz/db/${selectedPair}` })
      } catch (e: unknown) {
        if ((e as any)?.name === 'AbortError') return
        setError((e as Error).message || 'Unknown error')
      } finally {
        setIsLoading(false)
      }
    }
    fetchData()
    return () => controller.abort()
  }, [selectedPair])

  useEffect(() => {
    if (!workerRef.current || !agg) return
    const baseCriteria: any = { fromTs, toTs, direction: 'ALL' }
    if (activeView === 'solver') baseCriteria.solverIncludes = '0xa97851357e99082762c972f794b2a29e629511a7'
    workerRef.current.postMessage({ type: 'filter', criteria: baseCriteria })
  }, [fromTs, toTs, activeView])

  // no sample preview table

  return (
    <div className="app">
      <div className="container">
        <header className="header">
          <h1>Mainnet Analytics</h1>
          <div className="tabs">
            <button className={activeView==='analytics' ? 'active' : ''} onClick={() => setActiveView('analytics')}>Market</button>
            {/*   <button className={activeView==='solver' ? 'active' : ''} onClick={() => setActiveView('solver')}>Solver: Prycto</button> */}
          </div>
        </header>

        <main className="page">
            <section style={{ display: activeView==='analytics' ? 'block' : 'none' }}>
              <h2>Analytics</h2>
              <div className="panel" style={{ marginTop: 12 }}>
                <div className="controls" style={{ marginBottom: 12 }}>
                  <label>
                    Pair
                    <select
                      value={selectedPair}
                      onChange={e => setSelectedPair(e.target.value as PairKey)}
                      aria-label="Select collection/pair"
                    >
                      <option value="USDC-USDE">USDC-USDE</option>
                      <option value="USDC-USDT">USDC-USDT</option>
                      <option value="USDC-WBTC">USDC-WBTC</option>
                      <option value="USDC-WETH">USDC-WETH</option>
                    </select>
                  </label>
                  <label style={{ marginLeft: 12 }}>
                    Start day (UTC)
                    <input type="date" value={fromTs ? tsToDay(fromTs) : (agg?.dailySeries?.[0]?.day || '')} onChange={e => setFromTs(e.target.value ? dayStrToStartTs(e.target.value) : undefined)} />
                  </label>
                  <label style={{ marginLeft: 12 }}>
                    End day (UTC)
                    <input type="date" value={toTs ? tsToDay(toTs) : (agg?.dailySeries?.[agg.dailySeries.length-1]?.day || '')} onChange={e => setToTs(e.target.value ? dayStrToEndTs(e.target.value) : undefined)} />
                  </label>
                  <div style={{ display: 'inline-flex', gap: 8, marginLeft: 12 }}>
                    <button onClick={() => { const now = new Date(); const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()-1)); const day = y.toISOString().slice(0,10); setFromTs(dayStrToStartTs(day)); setToTs(dayStrToEndTs(day)); }}>Yesterday</button>
                    <button onClick={() => { const base = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())); const end = new Date(base.getTime() - 1); const start = new Date(base.getTime() - 7*24*60*60*1000); setFromTs(Math.floor(start.getTime()/1000)); setToTs(Math.floor(end.getTime()/1000)); }}>Last 7 days</button>
                    <button onClick={() => { const base = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())); const end = new Date(base.getTime() - 1); const start = new Date(base.getTime() - 30*24*60*60*1000); setFromTs(Math.floor(start.getTime()/1000)); setToTs(Math.floor(end.getTime()/1000)); }}>Last 30 days</button>
                  </div>
                  
                </div>

                {isLoading && <div className="muted">Loading {selectedPair}…</div>}
                {error && (
                  <div className="panel" style={{ marginTop: 12 }}>
                    <div>Failed to load data for {selectedPair}</div>
                    <div className="muted">{error}</div>
                  </div>
                )}
                {!isLoading && !error && apiData && (
                  <>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <div className="panel" style={{ flex: '0 0 auto' }}>
                        <div className="muted">Collection</div>
                        <div className="val">{apiData.collection}</div>
                      </div>
                      <div className="panel" style={{ flex: '0 0 auto' }}>
                        <div className="muted">Count</div>
                        <div className="val">{apiData.count.toLocaleString()}</div>
                      </div>
                      {agg && (
                        <>
                          <div className="panel" style={{ flex: '0 0 auto' }}>
                            <div className="muted">Total trades</div>
                            <div className="val">{agg.totalTrades.toLocaleString()}</div>
                          </div>
                          <div className="panel" style={{ flex: '0 0 auto' }}>
                            <div className="muted">Avg profit / trade</div>
                            <div className="val">{(() => {
                              const avgProfit = agg.avgProfitPerTradeUSDC || 0
                              const meanNotional = (agg.totalNotionalUSDC || 0) / Math.max(1, agg.totalTrades || 0)
                              const bps = meanNotional > 0 ? (avgProfit / meanNotional) * 10000 : 0
                              return `$${formatUSDCCompact(avgProfit)} (${bps.toFixed(1)} bps)`
                            })()}</div>
                          </div>
                        </>
                      )}
                    </div>

                    {agg && (
                      <>
                      <div className="panel" style={{ marginTop: 12 }}>
                        <h3 style={{ marginTop: 0 }}>Volume repartition by order size</h3>
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Size bucket</th>
                              <th>Trades</th>
                              <th>Volume</th>
                              <th>Avg participants</th>
                              <th>Avg profit/trade</th>
                            </tr>
                          </thead>
                          <tbody>
                            {agg.sizeSegments?.map(seg => (
                              <tr key={seg.bucket}>
                                <td>{formatRangeBucketLabel(seg.bucket)}</td>
                                <td>{seg.count.toLocaleString()}</td>
                                <td>${formatUSDCCompact(seg.volumeUSDC)}</td>
                                <td>{seg.avgParticipants.toFixed(2)}</td>
                                <td>{(() => {
                                  const avgProfit = seg.avgProfitPerTradeUSDC
                                  const meanNotional = seg.count ? (seg.volumeUSDC / seg.count) : 0
                                  const bps = meanNotional > 0 ? (avgProfit / meanNotional) * 10000 : 0
                                  return `$${formatUSDCCompact(avgProfit)} (${bps.toFixed(1)} bps)`
                                })()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="panel" style={{ marginTop: 12 }}>
                        <h3 style={{ marginTop: 0 }}>Volume share by size</h3>
                        <PieChart data={agg.sizeSegments || []} labelKey="bucket" valueKey="volumeUSDC" />
                      </div>
                      <div className="panel" style={{ marginTop: 12 }}>
                        <h3 style={{ marginTop: 0 }}>Leaders by size</h3>
                        {agg.sizeSegments?.map(seg => (
                          <div key={seg.bucket} style={{ marginBottom: 16 }}>
                            <h4 style={{ margin: '8px 0' }}>{formatRangeBucketLabel(seg.bucket)}</h4>
                            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                              <div style={{ flex: '1 1 260px' }}>
                                <div className="muted" style={{ marginBottom: 6 }}>Top 5 by profit</div>
                                <table className="table">
                                  <thead>
                                    <tr>
                                      <th>Solver</th>
                                      <th>Profit</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {seg.topByProfit.map(row => (
                                      <tr key={`p-${seg.bucket}-${row.solverAddress}`}>
                                        <td><code title={row.solverAddress}>{solverLabel(row.solverAddress)}</code></td>
                                        <td>${formatUSDCCompact(row.totalProfitUSDC)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <div style={{ flex: '1 1 260px' }}>
                                <div className="muted" style={{ marginBottom: 6 }}>Top 5 by win rate</div>
                                <table className="table">
                                  <thead>
                                    <tr>
                                      <th>Solver</th>
                                      <th>Win rate</th>
                                      <th>W/T</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {seg.topByWinRate.map(row => (
                                      <tr key={`w-${seg.bucket}-${row.solverAddress}`}>
                                        <td><code title={row.solverAddress}>{solverLabel(row.solverAddress)}</code></td>
                                        <td>{(row.winRate * 100).toFixed(1)}%</td>
                                        <td>{row.wins}/{row.tradesParticipated}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                              <div style={{ flex: '1 1 260px' }}>
                                <div className="muted" style={{ marginBottom: 6 }}>Top 5 by volume</div>
                                <table className="table">
                                  <thead>
                                    <tr>
                                      <th>Solver</th>
                                      <th>Volume</th>
                                      <th>Wins</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {seg.topByVolume.map(row => (
                                      <tr key={`v-${seg.bucket}-${row.solverAddress}`}>
                                        <td><code title={row.solverAddress}>{solverLabel(row.solverAddress)}</code></td>
                                        <td>${formatUSDCCompact(row.volumeUSDC)}</td>
                                        <td>{row.wins}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="panel" style={{ marginTop: 12 }}>
                        <h3 style={{ marginTop: 0 }}>FAQ: How do we compute profit?</h3>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          <li>We compute USDC-per-token for each solution, using token decimals.</li>
                          <li>Profit is winner vs second-best: Δprice × filled token quantity, clamped at 0.</li>
                          <li>When selling token for USDC (TOKEN → USDC), higher USDC/token is better; quantity = TOKEN sold.</li>
                          <li>When buying token with USDC (USDC → TOKEN), lower USDC/token is better; quantity = TOKEN bought.</li>
                          <li>Fees are ignored for now. This works for BTC/ETH and stable pairs (USDT/USDE) alike.</li>
                        </ul>
                      </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </section>
            <section style={{ display: activeView==='solver' ? 'block' : 'none' }}>
              <h2>Solver Analysis: Prycto</h2>
              <div className="panel" style={{ marginTop: 12 }}>
                <div className="controls" style={{ marginBottom: 12 }}>
                  <div className="muted">Orders participated by solver 0xa97851357e99082762c972f794b2a29e629511a7</div>
                  <div className="muted">Time range filters above apply here as well.</div>
                </div>
                {!isLoading && !error && agg && (
                  <>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <div className="panel" style={{ flex: '0 0 auto' }}>
                        <div className="muted">Total trades (filtered)</div>
                        <div className="val">{agg.totalTrades.toLocaleString()}</div>
                      </div>
                      <div className="panel" style={{ flex: '0 0 auto' }}>
                        <div className="muted">Avg profit / trade</div>
                        <div className="val">{(() => {
                          const avgProfit = agg.avgProfitPerTradeUSDC || 0
                          const meanNotional = (agg.totalNotionalUSDC || 0) / Math.max(1, agg.totalTrades || 0)
                          const bps = meanNotional > 0 ? (avgProfit / meanNotional) * 10000 : 0
                          return `$${formatUSDCCompact(avgProfit)} (${bps.toFixed(1)} bps)`
                        })()}</div>
                      </div>
                    </div>
                    <div className="panel" style={{ marginTop: 12 }}>
                      <h3 style={{ marginTop: 0 }}>Volume share by size</h3>
                      <PieChart data={agg.sizeSegments || []} labelKey="bucket" valueKey="volumeUSDC" />
                    </div>
                  </>
                )}
              </div>
            </section>
        </main>
      </div>
    </div>
  )
}

export default App


