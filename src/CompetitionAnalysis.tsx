import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { TradeDocument, TradesApiResponse } from './types'
import { solverLabel } from './utils/solvers'
import { normalizeAmount } from './utils/price'
import { formatUSDCCompact } from './utils/format'
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend } from 'recharts'
import { higherPriceIsBetterUSDCPerToken } from './utils/price'

type ApiItem = {
  _id: string
  orderUid: string
  transactionHash?: string
  txHash?: string
  blockNumber: number
  blockTimestamp: number | string
  buyAmount: string
  buyToken: string
  cowswapFeeAmount?: string | number | null
  owner: string
  sellAmount: string
  sellToken: string
  competitionData?: Array<{
    solverAddress?: string
    sellAmount?: string
    buyAmount?: string
    winner?: boolean
  }>
  binancePrices?: TradeDocument['binancePrices']
}

type ApiResponse = { items: ApiItem[] }

function mapApiItemToTradeDocument(item: ApiItem): TradeDocument {
  const bids = (item.competitionData || []).map((b) => ({
    solverAddress: String(b.solverAddress || ''),
    sellAmount: String(b.sellAmount || '0'),
    buyAmount: String(b.buyAmount || '0'),
    winner: Boolean(b.winner),
  }))
  const tsRaw = item.blockTimestamp
  const tsNum = typeof tsRaw === 'string' ? Number(tsRaw) : tsRaw
  return {
    _id: item._id,
    orderUid: item.orderUid,
    txHash: item.txHash || item.transactionHash || '',
    blockNumber: item.blockNumber,
    blockTimestamp: tsNum as number,
    buyAmount: item.buyAmount,
    buyToken: item.buyToken,
    owner: item.owner,
    sellAmount: item.sellAmount,
    sellToken: item.sellToken,
    cowswapFeeAmount: BigInt(String(item.cowswapFeeAmount ?? '0')),
    competitionData: bids.length > 0 ? { bidData: bids } : undefined,
    binancePrices: item.binancePrices,
  }
}

const DEFAULT_TOKEN_A = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const DEFAULT_TOKEN_B = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

export default function CompetitionAnalysis() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [documents, setDocuments] = useState<TradeDocument[]>([])
  const [timeSpan, setTimeSpan] = useState<'yesterday' | 'last7' | 'last30'>('last30')
  const [tokenA, setTokenA] = useState<string>(DEFAULT_TOKEN_A)
  const [tokenB, setTokenB] = useState<string>(DEFAULT_TOKEN_B)

  useEffect(() => {
    const abort = new AbortController()
    async function load() {
      try {
        setLoading(true)
        setError(null)
        const apiBase = 'https://cowswap-data-api.la-tribu.xyz'
        const url = new URL(apiBase + '/trades', window.location.origin)
        url.searchParams.set('tokenA', tokenA)
        url.searchParams.set('tokenB', tokenB)
        const res = await fetch(url.toString(), { signal: abort.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const contentType = res.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
          const txt = await res.text()
          throw new Error(`Unexpected response content-type: ${contentType}. Body: ${txt.slice(0, 200)}`)
        }
        const json = (await res.json()) as ApiResponse | TradesApiResponse
        const items = Array.isArray((json as ApiResponse).items)
          ? (json as ApiResponse).items
          : Array.isArray((json as TradesApiResponse).documents)
          ? (json as TradesApiResponse).documents
          : []
        const mapped = (items as ApiItem[]).map(mapApiItemToTradeDocument)
        setDocuments(mapped)
      } catch (e) {
        if ((e as { name?: string } | null)?.name === 'AbortError') return
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    }
    load()
    return () => abort.abort()
  }, [tokenA, tokenB])

  const filteredDocs = useMemo(() => {
    const now = new Date()
    const endSec = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000)
    const day = 24 * 60 * 60
    const startSec =
      timeSpan === 'yesterday'
        ? endSec - day
        : timeSpan === 'last7'
        ? endSec - 7 * day
        : endSec - 30 * day
    return documents.filter((d) => {
      const ts = d.blockTimestamp
      return Number.isFinite(ts) && (ts as number) >= startSec && (ts as number) < endSec
    })
  }, [documents, timeSpan])

  // Filter to orders where margin can be computed (both Binance prices available and direction known)
  const computableDocs = useMemo(() => {
    return filteredDocs.filter((d) => {
      const sellPx = (d.binancePrices as { sellTokenInUSD?: number } | undefined)?.sellTokenInUSD
      const buyPx = (d.binancePrices as { buyTokenInUSD?: number } | undefined)?.buyTokenInUSD
      if (!Number.isFinite(sellPx) || !Number.isFinite(buyPx)) return false
      const dir = higherPriceIsBetterUSDCPerToken(d.sellToken, d.buyToken)
      if (dir === null) return false
      return true
    })
  }, [filteredDocs])

  const solverWins = useMemo(() => {
    const counts: Record<string, { count: number; volume: number }> = {}
    for (const d of computableDocs) {
      const bids = d.competitionData?.bidData || []
      const winner = bids.find((b) => b?.winner)
      const addr = (winner?.solverAddress || '').toLowerCase()
      if (!addr) continue
      if (!counts[addr]) counts[addr] = { count: 0, volume: 0 }
      counts[addr].count += 1
      const px = (d.binancePrices as { sellTokenInUSD?: number } | undefined)?.sellTokenInUSD
      const amount = normalizeAmount(d.sellAmount, d.sellToken)
      if (Number.isFinite(px) && Number.isFinite(amount)) {
        counts[addr].volume += (amount as number) * (px as number)
      }
    }
    const total = computableDocs.length || 0
    return Object.entries(counts)
      .map(([address, { count, volume }]) => ({ address, label: solverLabel(address), count, volume, winRatePct: total > 0 ? (count / total) * 100 : 0 }))
      .sort((a, b) => b.count - a.count)
  }, [computableDocs])

  const totalWins = useMemo(() => solverWins.reduce((acc, s) => acc + s.count, 0), [solverWins])
  const totalVolume = useMemo(() => solverWins.reduce((acc, s) => acc + s.volume, 0), [solverWins])

  // Top 10 solvers by win rate (not volume)
  const top10ByWinRate = useMemo(() => {
    return solverWins
      .slice()
      .sort((a, b) => b.winRatePct - a.winRatePct)
      .slice(0, 10)
      .map((s) => s.address.toLowerCase())
  }, [solverWins])

  // Solver margin vs market: compute delta for all bids per solver, aggregate hourly, 6h MA per solver, and pivot for chart
  const solverHourlyChart = useMemo(() => {
    const solverHourAgg: Map<string, Map<number, { sum: number; n: number }>> = new Map()
    const hoursSet = new Set<number>()
    for (const d of computableDocs) {
      const sellPx = (d.binancePrices as { sellTokenInUSD?: number } | undefined)?.sellTokenInUSD
      const buyPx = (d.binancePrices as { buyTokenInUSD?: number } | undefined)?.buyTokenInUSD
      if (!Number.isFinite(sellPx) || !Number.isFinite(buyPx)) continue
      const market = sellPx as number
      const buyUsdc = buyPx as number
      const dir = higherPriceIsBetterUSDCPerToken(d.sellToken, d.buyToken)
      if (dir === null || market === 0) continue
      const hour = Math.floor((d.blockTimestamp as number) / 3600) * 3600
      hoursSet.add(hour)
      const bids = d.competitionData?.bidData || []
      for (const b of bids) {
        const sellQty = normalizeAmount(b.sellAmount, d.sellToken)
        const buyQty = normalizeAmount(b.buyAmount, d.buyToken)
        if (!Number.isFinite(sellQty) || !Number.isFinite(buyQty) || sellQty === 0) continue
        const implied = buyUsdc * ((buyQty as number) / (sellQty as number))
        if (!Number.isFinite(implied)) continue
        const rawPct = ((implied - market) / market) * 100
        const adjustedPct = rawPct * (dir ? 1 : -1)
        const solver = (b.solverAddress || '').toLowerCase()
        if (!solver) continue
        const byHour = solverHourAgg.get(solver) || new Map<number, { sum: number; n: number }>()
        const e = byHour.get(hour) || { sum: 0, n: 0 }
        e.sum += adjustedPct
        e.n += 1
        byHour.set(hour, e)
        solverHourAgg.set(solver, byHour)
      }
    }
    const hours = Array.from(hoursSet.values()).sort((a, b) => a - b)
    // Build per-solver hourly averages and 6h MA
    const solverSeries: { key: string; label: string; color: string; points: { hour: number; avgPct: number }[] }[] = []
    const palette = ['#2563eb','#ef4444','#10b981','#f59e0b','#8b5cf6','#06b6d4','#f97316','#84cc16','#ec4899','#22d3ee']
    let colorIdx = 0
    for (const [solver, byHour] of solverHourAgg.entries()) {
      if (top10ByWinRate.length > 0 && !top10ByWinRate.includes(solver)) continue
      const label = solverLabel(solver)
      const color = palette[colorIdx % palette.length]
      colorIdx += 1
      const pts = hours.map((h) => {
        const e = byHour.get(h)
        const v = e && e.n > 0 ? e.sum / e.n : NaN
        return { hour: h, avgPct: v }
      })
      // 6h MA
      const windowSize = 6
      const ptsMA = pts.map((_, i) => {
        let sum = 0
        let cnt = 0
        for (let j = Math.max(0, i - (windowSize - 1)); j <= i; j++) {
          const v = pts[j].avgPct
          if (Number.isFinite(v)) { sum += v as number; cnt += 1 }
        }
        return { hour: pts[i].hour, avgPct: cnt > 0 ? sum / cnt : NaN }
      })
      solverSeries.push({ key: solver, label, color, points: ptsMA })
    }
    // Pivot rows: one row per hour, columns per solver key
    const rows = hours.map((h) => {
      const hourLabel = new Date(h * 1000).toISOString().slice(0, 13).replace('T', ' ')
      const row: Record<string, number | string> = { hour: h, hourLabel }
      for (const s of solverSeries) {
        const p = s.points.find((pt) => pt.hour === h)
        if (p && Number.isFinite(p.avgPct)) row[s.key] = p.avgPct
      }
      return row
    })
    return { rows, series: solverSeries }
  }, [computableDocs, top10ByWinRate, tokenA, tokenB, timeSpan])

  return (
    <div>
      <div style={{ borderBottom: '1px solid #e5e7eb', background: '#ffffff' }}>
        <div style={{ maxWidth: 960, margin: '0 auto', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ fontWeight: 600 }}>Mainnet Analytics</div>
          <nav style={{ display: 'flex', gap: 12 }}>
            <Link to="/">Home</Link>
            <Link to="/trades">Trades</Link>
            <Link to="/competition">Competition</Link>
          </nav>
          <div />
        </div>
      </div>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
        <h1>Competition Analysis</h1>

        {/* Filters (same as App) */}
        <div style={{ marginTop: '1rem', marginBottom: '0.25rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="timespan">Time span</label>
          <select id="timespan" value={timeSpan} onChange={(e) => setTimeSpan(e.target.value as 'yesterday' | 'last7' | 'last30')}>
            <option value="yesterday">Yesterday</option>
            <option value="last7">Last 7 days</option>
            <option value="last30">Last 30 days</option>
          </select>
          <label htmlFor="token-a">Token A</label>
          <select id="token-a" value={tokenA} onChange={(e) => setTokenA(e.target.value)}>
            <option value="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48">USDC</option>
            <option value="0xdac17f958d2ee523a2206206994597c13d831ec7">USDT</option>
            <option value="0x2260fac5e5542a773aa44fbcfedf7c193bc2c599">WBTC</option>
            <option value="0x4c9edd5852cd905f086c759e8383e09bff1e68b3">USDE</option>
            <option value="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2">WETH</option>
          </select>
          <label htmlFor="token-b">Token B</label>
          <select id="token-b" value={tokenB} onChange={(e) => setTokenB(e.target.value)}>
            <option value="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48">USDC</option>
            <option value="0xdac17f958d2ee523a2206206994597c13d831ec7">USDT</option>
            <option value="0x2260fac5e5542a773aa44fbcfedf7c193bc2c599">WBTC</option>
            <option value="0x4c9edd5852cd905f086c759e8383e09bff1e68b3">USDE</option>
            <option value="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2">WETH</option>
          </select>
        </div>

        {loading ? (
          <p>Loading…</p>
        ) : error ? (
          <p style={{ color: '#dc2626' }}>Error: {error}</p>
        ) : (
          <div style={{ display: 'flex', gap: '1rem' }}>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
              <div>Total trades</div>
              <div>{filteredDocs.length.toLocaleString()}</div>
            </div>
          </div>
        )}

        {!loading && !error && (
          <>
            <h2 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: 600 }}>Solver wins</h2>
            {solverWins.length === 0 ? (
              <div style={{ color: '#6b7280' }}>No data</div>
            ) : (
              <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Solver</th>
                    <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Wins</th>
                    <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Win rate</th>
                    <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Win rate (vol)</th>
                    <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Volume won (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {solverWins.map((s) => (
                    <tr key={s.address} className="odd:bg-white even:bg-gray-50">
                      <td className="px-4 py-2 border-b" title={s.address}>{s.label}</td>
                      <td className="px-4 py-2 border-b text-right">{s.count.toLocaleString()}</td>
                      <td className="px-4 py-2 border-b text-right">{`${s.winRatePct.toFixed(1)}%`}</td>
                      <td className="px-4 py-2 border-b text-right">{totalVolume > 0 ? `${((s.volume / totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                      <td className="px-4 py-2 border-b text-right">{`$${formatUSDCCompact(s.volume)}`}</td>
                    </tr>
                  ))}
                  <tr className="odd:bg-white even:bg-gray-50">
                    <td className="px-4 py-2 border-b" style={{ fontWeight: 600 }}>Total</td>
                    <td className="px-4 py-2 border-b text-right" style={{ fontWeight: 600 }}>{totalWins.toLocaleString()}</td>
                    <td className="px-4 py-2 border-b text-right" style={{ fontWeight: 600 }}>{solverWins.length > 0 ? '100.0%' : '-'}</td>
                    <td className="px-4 py-2 border-b text-right" style={{ fontWeight: 600 }}>{totalVolume > 0 ? '100.0%' : '-'}</td>
                    <td className="px-4 py-2 border-b text-right" style={{ fontWeight: 600 }}>{`$${formatUSDCCompact(totalVolume)}`}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </>
        )}

        {/* Chart temporarily hidden */}
      </div>
    </div>
  )
}


