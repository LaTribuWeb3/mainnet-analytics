import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { BidDatum, TradeDocument, TradesApiResponse } from './types'
import { normalizeAmount, toDay } from './utils/price'
import { formatCompactTruncate } from './utils/format'
import { solverLabel } from './utils/solvers'

const API_PATH = '/trades'

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

type ApiResponse = {
  items: ApiItem[]
}

function mapApiItemToTradeDocument(item: ApiItem): TradeDocument {
  const bids: BidDatum[] = (item.competitionData || []).map((b) => ({
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
    blockTimestamp: tsNum,
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

export default function TradesPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [documents, setDocuments] = useState<TradeDocument[]>([])
  // no clipboard UI; using external links instead
  const [startDate, setStartDate] = useState<string | null>(null)
  const [endDate, setEndDate] = useState<string | null>(null)
  const [sellTokenFilter, setSellTokenFilter] = useState<string>('')
  const [buyTokenFilter, setBuyTokenFilter] = useState<string>('')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [onlyPryctoParticipated, setOnlyPryctoParticipated] = useState<boolean>(false)
  const [onlyPryctoWinner, setOnlyPryctoWinner] = useState<boolean>(false)

  const PRYCTO_ADDRESS = '0xa97851357e99082762c972f794b2a29e629511a7'

  useEffect(() => {
    const abort = new AbortController()
    async function load() {
      try {
        setLoading(true)
        setError(null)
        // Build query with token addresses if both are provided
        const apiBase = import.meta.env.DEV ? '/api' : 'https://cowswap-data-api.la-tribu.xyz'
        const url = new URL(apiBase + API_PATH, window.location.origin)
        const a = sellTokenFilter.trim()
        const b = buyTokenFilter.trim()
        if (a && b) {
          url.searchParams.set('tokenA', a)
          url.searchParams.set('tokenB', b)
        }
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
  }, [sellTokenFilter, buyTokenFilter])

  const summary = useMemo(() => {
    return {
      count: documents.length,
      uniqueOwners: new Set(documents.map((d) => d.owner.toLowerCase())).size,
    }
  }, [documents])

  // Establish default date range once data is loaded: earliest day to latest day (UTC)
  useEffect(() => {
    if (documents.length === 0) return
    if (startDate && endDate) return
    let minTs = Number.POSITIVE_INFINITY
    let maxTs = 0
    for (const d of documents) {
      const ts = d.blockTimestamp
      if (Number.isFinite(ts)) {
        if ((ts as number) < minTs) minTs = ts as number
        if ((ts as number) > maxTs) maxTs = ts as number
      }
    }
    if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return
    const minDay = toDay(minTs as number)
    const maxDay = toDay(maxTs as number)
    if (!startDate) setStartDate(minDay)
    if (!endDate) setEndDate(maxDay)
  }, [documents, startDate, endDate, sellTokenFilter, buyTokenFilter])

  function dayStartSec(dayStr: string): number {
    const [y, m, d] = dayStr.split('-').map((x) => Number(x))
    return Math.floor(Date.UTC(y, (m as number) - 1, d as number) / 1000)
  }

  const filteredDocs = useMemo(() => {
    const hasDates = !!startDate && !!endDate
    const startSec = hasDates ? dayStartSec(startDate as string) : 0
    const endExclusive = hasDates ? dayStartSec(endDate as string) + 24 * 60 * 60 : Number.POSITIVE_INFINITY
    return documents.filter((d) => {
      const ts = d.blockTimestamp
      if (!(Number.isFinite(ts) && (ts as number) >= startSec && (ts as number) < endExclusive)) return false
      if (sellTokenFilter && d.sellToken.toLowerCase() !== sellTokenFilter.toLowerCase()) return false
      if (buyTokenFilter && d.buyToken.toLowerCase() !== buyTokenFilter.toLowerCase()) return false
      if (onlyPryctoParticipated || onlyPryctoWinner) {
        const bids = (d.competitionData?.bidData || [])
        const participated = bids.some((b) => (b.solverAddress || '').toLowerCase() === PRYCTO_ADDRESS)
        if (onlyPryctoParticipated && !participated) return false
        if (onlyPryctoWinner) {
          const winner = bids.find((b) => b.winner)
          const isWin = !!winner && (winner?.solverAddress || '').toLowerCase() === PRYCTO_ADDRESS
          if (!isWin) return false
        }
      }
      return true
    })
  }, [documents, startDate, endDate, sellTokenFilter, buyTokenFilter, onlyPryctoParticipated, onlyPryctoWinner])

  const minMaxDays = useMemo(() => {
    if (documents.length === 0) return { minDay: '', maxDay: '' }
    let minTs = Number.POSITIVE_INFINITY
    let maxTs = 0
    for (const d of documents) {
      const ts = d.blockTimestamp
      if (Number.isFinite(ts)) {
        if ((ts as number) < minTs) minTs = ts as number
        if ((ts as number) > maxTs) maxTs = ts as number
      }
    }
    if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) return { minDay: '', maxDay: '' }
    return { minDay: toDay(minTs as number), maxDay: toDay(maxTs as number) }
  }, [documents])

  function truncate6(value: string): string {
    return value.length <= 6 ? value : value.slice(0, 6)
  }

  function tokenSymbol(addr: string): string {
    const a = addr.toLowerCase()
    if (a === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') return 'USDC'
    if (a === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2') return 'WETH'
    if (a === '0xdac17f958d2ee523a2206206994597c13d831ec7') return 'USDT'
    if (a === '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599') return 'WBTC'
    if (a === '0x4c9edd5852cd905f086c759e8383e09bff1e68b3') return 'USDE'
    return truncate6(addr)
  }

  function formatTokenAmount(raw: string, token: string): string {
    const v = normalizeAmount(raw, token)
    if (!Number.isFinite(v)) return '-'
    const sym = tokenSymbol(token)
    if (sym === 'USDC' || sym === 'USDT' || sym === 'USDE') {
      return `${formatCompactTruncate(v as number, 2)} ${sym}`
    }
    const s = (v as number).toFixed(6).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1')
    return `${s} ${sym}`
  }

  const cowOrderUrl = (uid: string) => `https://explorer.cow.fi/orders/${uid}`
  const etherscanTxUrl = (tx: string) => `https://etherscan.io/tx/${tx}`

  function formatUsdVolume(doc: TradeDocument): string {
    const amount = normalizeAmount(doc.sellAmount, doc.sellToken)
    const px = (doc.binancePrices as { sellTokenInUSD?: number } | undefined)?.sellTokenInUSD
    if (!Number.isFinite(amount) || !Number.isFinite(px)) return '-'
    const vol = (amount as number) * (px as number)
    return `$${formatCompactTruncate(vol, 2)}`
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  function formatLocalDateTime(tsSec: number): string {
    try {
      return new Date(tsSec * 1000).toLocaleString()
    } catch {
      return '-'
    }
  }

  if (loading) {
    return (
      <div>
        <div style={{ borderBottom: '1px solid #e5e7eb', background: '#ffffff' }}>
          <div style={{ maxWidth: 960, margin: '0 auto', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ fontWeight: 600 }}>Mainnet Analytics</div>
            <nav style={{ display: 'flex', gap: 12 }}>
              <Link to="/">Home</Link>
              <Link to="/trades">Trades</Link>
            </nav>
            <div />
          </div>
        </div>
        <div style={{ maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
          <h1>Trades (Cowswap Data API)</h1>
          <p>Loading…</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <div style={{ borderBottom: '1px solid #e5e7eb', background: '#ffffff' }}>
          <div style={{ maxWidth: 960, margin: '0 auto', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div style={{ fontWeight: 600 }}>Mainnet Analytics</div>
            <nav style={{ display: 'flex', gap: 12 }}>
              <Link to="/">Home</Link>
              <Link to="/trades">Trades</Link>
            </nav>
            <div />
          </div>
        </div>
        <div style={{ maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
          <h1>Trades (Cowswap Data API)</h1>
          <p style={{ color: '#dc2626' }}>Error: {error}</p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ borderBottom: '1px solid #e5e7eb', background: '#ffffff' }}>
        <div style={{ maxWidth: 960, margin: '0 auto', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ fontWeight: 600 }}>Mainnet Analytics</div>
          <nav style={{ display: 'flex', gap: 12 }}>
            <Link to="/">Home</Link>
            <Link to="/trades">Trades</Link>
          </nav>
          <div />
        </div>
      </div>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
      <h1>Trades (Cowswap Data API)</h1>
      <div style={{ display: 'flex', gap: '1rem' }}>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
          <div>Total trades</div>
          <div>{summary.count.toLocaleString()}</div>
        </div>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
          <div>Unique owners</div>
          <div>{summary.uniqueOwners.toLocaleString()}</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ marginTop: '1rem', marginBottom: '0.25rem', display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <label htmlFor="start-date">From</label>
        <input
          id="start-date"
          type="date"
          value={startDate ?? ''}
          min={minMaxDays.minDay}
          max={endDate ?? minMaxDays.maxDay}
          onChange={(e) => setStartDate(e.target.value || null)}
        />
        <label htmlFor="end-date">to</label>
        <input
          id="end-date"
          type="date"
          value={endDate ?? ''}
          min={startDate ?? minMaxDays.minDay}
          max={minMaxDays.maxDay}
          onChange={(e) => setEndDate(e.target.value || null)}
        />
        <label htmlFor="sell-token">Sell token</label>
        <select id="sell-token" value={sellTokenFilter} onChange={(e) => setSellTokenFilter(e.target.value)}>
          <option value="">Any</option>
          <option value="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48">USDC</option>
          <option value="0xdac17f958d2ee523a2206206994597c13d831ec7">USDT</option>
          <option value="0x2260fac5e5542a773aa44fbcfedf7c193bc2c599">WBTC</option>
          <option value="0x4c9edd5852cd905f086c759e8383e09bff1e68b3">USDE</option>
          <option value="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2">WETH</option>
        </select>
        <label htmlFor="buy-token">Buy token</label>
        <select id="buy-token" value={buyTokenFilter} onChange={(e) => setBuyTokenFilter(e.target.value)}>
          <option value="">Any</option>
          <option value="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48">USDC</option>
          <option value="0xdac17f958d2ee523a2206206994597c13d831ec7">USDT</option>
          <option value="0x2260fac5e5542a773aa44fbcfedf7c193bc2c599">WBTC</option>
          <option value="0x4c9edd5852cd905f086c759e8383e09bff1e68b3">USDE</option>
          <option value="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2">WETH</option>
        </select>
      </div>

      <div style={{ marginTop: '0.25rem', marginBottom: '0.5rem', display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <label>
          <input
            type="checkbox"
            checked={onlyPryctoParticipated}
            onChange={(e) => setOnlyPryctoParticipated(e.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>Prycto participated</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={onlyPryctoWinner}
            onChange={(e) => setOnlyPryctoWinner(e.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>Prycto winner</span>
        </label>
      </div>

      <h2 style={{ marginTop: 0, marginBottom: '0.5rem', fontWeight: 600 }}>Latest trades</h2>
      <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Time</th>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Order UID</th>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Tx</th>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Sell</th>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Buy</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Volume (USD)</th>
          </tr>
        </thead>
        <tbody>
          {filteredDocs.slice(0, 50).map((d) => {
            const isOpen = !!expanded[d._id]
            return (
              <>
                <tr
                  key={d._id}
                  className="odd:bg-white even:bg-gray-50"
                  onClick={() => toggleExpanded(d._id)}
                  style={{ cursor: 'pointer' }}
                  aria-expanded={isOpen}
               >
                  <td className="px-4 py-2 border-b" title={String(d.blockTimestamp)}>{formatLocalDateTime(d.blockTimestamp)}</td>
                  <td className="px-4 py-2 border-b" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <a
                      href={cowOrderUrl(d.orderUid)}
                      target="_blank"
                      rel="noreferrer"
                      title={d.orderUid}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {truncate6(d.orderUid)}...
                    </a>
                  </td>
                  <td className="px-4 py-2 border-b" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    <a
                      href={etherscanTxUrl(d.txHash)}
                      target="_blank"
                      rel="noreferrer"
                      title={d.txHash}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {truncate6(d.txHash)}...
                    </a>
                  </td>
                  <td className="px-4 py-2 border-b" title={d.sellToken}>{formatTokenAmount(d.sellAmount, d.sellToken)}</td>
                  <td className="px-4 py-2 border-b" title={d.buyToken}>{formatTokenAmount(d.buyAmount, d.buyToken)}</td>
                  <td className="px-4 py-2 border-b text-right">{formatUsdVolume(d)}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td className="px-4 py-2 border-b bg-gray-50" colSpan={6}>
                      {d.competitionData?.bidData && d.competitionData.bidData.length > 0 ? (
                        <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
                          <thead>
                            <tr>
                              <th className="px-2 py-1 text-left text-xs font-semibold text-gray-700 border-b">Solver</th>
                              <th className="px-2 py-1 text-left text-xs font-semibold text-gray-700 border-b">Sell bid</th>
                              <th className="px-2 py-1 text-left text-xs font-semibold text-gray-700 border-b">Buy bid</th>
                              <th className="px-2 py-1 text-right text-xs font-semibold text-gray-700 border-b">Δ vs winner (bps)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(() => {
                              const bids = d.competitionData?.bidData || []
                              const winnerBid = bids.find((x) => x.winner)
                              const rest = bids.filter((x) => !x.winner)
                              const sortedRest = rest
                                .slice()
                                .sort((a, b) => {
                                  const ab = Number(normalizeAmount(a.buyAmount, d.buyToken))
                                  const bb = Number(normalizeAmount(b.buyAmount, d.buyToken))
                                  return (bb || 0) - (ab || 0)
                                })
                              const sorted = winnerBid ? [winnerBid, ...sortedRest] : sortedRest
                              const winnerBuy = winnerBid ? Number(normalizeAmount(winnerBid.buyAmount, d.buyToken)) : null
                              return sorted.map((b, idx) => {
                                const isWinner = !!b.winner
                                const bidBuy = Number(normalizeAmount(b.buyAmount, d.buyToken))
                                const deltaBps = winnerBuy && winnerBuy !== 0
                                  ? (((bidBuy - winnerBuy) / winnerBuy) * 10000)
                                  : null
                                return (
                                  <tr
                                    key={`${d._id}-bid-${idx}`}
                                    className="odd:bg-white even:bg-gray-50"
                                    style={{ backgroundColor: isWinner ? '#ecfdf5' : undefined, fontWeight: isWinner ? 600 : undefined }}
                                  >
                                    <td className="px-2 py-1 border-b" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }} title={b.solverAddress}>
                                      {solverLabel(b.solverAddress)}
                                    </td>
                                    <td className="px-2 py-1 border-b">{formatTokenAmount(b.sellAmount, d.sellToken)}</td>
                                    <td className="px-2 py-1 border-b">{formatTokenAmount(b.buyAmount, d.buyToken)}</td>
                                    <td className="px-2 py-1 border-b text-right">{deltaBps === null ? '-' : deltaBps.toFixed(1)}</td>
                                  </tr>
                                )
                              })
                            })()}
                          </tbody>
                        </table>
                      ) : (
                        <div style={{ color: '#6b7280' }}>No competition data</div>
                      )}
                    </td>
                  </tr>
                )}
              </>
            )
          })}
        </tbody>
      </table>
      </div>
    </div>
  )
}


