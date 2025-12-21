import { Fragment, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import baseTradesRaw from './data/base-trades.ndjson?raw'
import baseTokens from './data/base-tokens.json'
import type { BidDatum } from './types'
import { solverLabel } from './utils/solvers'
import { TOKEN_DECIMALS } from './utils/price'
import { formatCompactTruncate } from './utils/format'

type BaseTrade = {
  owner: string
  sellToken: string
  buyToken: string
  sellAmount: string
  buyAmount: string
  feeAmount?: string
  orderUid: string
  blockNumber: number
  transactionHash: string
  logIndex: number
  competitionData?: { bidData: BidDatum[] }
}

type EnrichedTrade = BaseTrade & {
  targetRank: number | null
  winnerAddress: string | null
  winnerBuyAmount: string | null
  bidCount: number
  sellUsd: number | null
}

type SortKey = 'blockNumber' | 'sellAmount' | 'buyAmount' | 'sellUsd' | 'targetRank' | 'winnerAddress'

const TARGET_SOLVER = '0x59019a97f9eea41385c476a954a30e3dacc25249'.toLowerCase()

type BaseToken = {
  address: string
  symbol?: string
  name?: string
  decimals?: number
  priceUsd?: number | null
}

type BaseTokensFile = {
  tokens?: BaseToken[]
}

function toBig(raw: string | undefined): bigint {
  try {
    return BigInt(raw ?? '0')
  } catch {
    return 0n
  }
}

function parseTrades(raw: string): BaseTrade[] {
  return raw
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      try {
        return JSON.parse(line) as BaseTrade
      } catch (e) {
        console.warn('Failed to parse line', idx, e)
        return null
      }
    })
    .filter((t): t is BaseTrade => t !== null)
}

function computeTargetRank(bids: BidDatum[] | undefined): number | null {
  if (!bids || bids.length === 0) return null
  const sorted = [...bids].sort((a, b) => {
    const diff = toBig(b.buyAmount) - toBig(a.buyAmount)
    if (diff === 0n) return 0
    return diff > 0n ? 1 : -1
  })
  const idx = sorted.findIndex((b) => (b.solverAddress || '').toLowerCase() === TARGET_SOLVER)
  return idx === -1 ? null : idx + 1
}

function buildTokenLookup(data: BaseTokensFile): Record<string, { symbol: string; name?: string; decimals: number; priceUsd: number | null }> {
  const map: Record<string, { symbol: string; name?: string; decimals: number; priceUsd: number | null }> = {}
  for (const t of data.tokens || []) {
    if (!t.address) continue
    const key = t.address.toLowerCase()
    map[key] = {
      symbol: t.symbol || key.slice(0, 6),
      name: t.name,
      decimals: typeof t.decimals === 'number' ? t.decimals : 18,
      priceUsd: typeof t.priceUsd === 'number' ? t.priceUsd : null,
    }
  }
  return map
}

function tokenDecimals(addr: string, tokenLookup: Record<string, { symbol: string; name?: string; decimals: number; priceUsd: number | null }>): number {
  const lc = (addr || '').toLowerCase()
  if (tokenLookup[lc]) return tokenLookup[lc].decimals
  return TOKEN_DECIMALS[lc] ?? 18
}

function tokenSymbol(addr: string, tokenLookup: Record<string, { symbol: string; name?: string; decimals: number; priceUsd: number | null }>): string {
  const lc = (addr || '').toLowerCase()
  if (tokenLookup[lc]?.symbol) return tokenLookup[lc].symbol
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : ''
}

function amountToFloat(raw: string, decimals: number): number {
  const clean = (raw || '0').replace(/^0+/, '') || '0'
  if (decimals === 0) return Number(clean)
  const padded = clean.padStart(decimals + 1, '0')
  const intPart = padded.slice(0, -decimals)
  const fracPart = padded.slice(-decimals).replace(/0+$/, '')
  const composed = fracPart ? `${intPart}.${fracPart}` : intPart
  return Number(composed)
}

function formatTokenAmount(raw: string, token: string, tokenLookup: Record<string, { symbol: string; name?: string; decimals: number; priceUsd: number | null }>): string {
  const dec = tokenDecimals(token, tokenLookup)
  const v = Number(raw) / 10 ** dec
  if (!Number.isFinite(v)) return raw
  return `${formatCompactTruncate(v, 3)} ${tokenSymbol(token, tokenLookup)}`
}

function computeUsdValue(raw: string, token: string, tokenLookup: Record<string, { symbol: string; name?: string; decimals: number; priceUsd: number | null }>): number | null {
  const dec = tokenDecimals(token, tokenLookup)
  const amount = amountToFloat(raw, dec)
  const px = tokenLookup[(token || '').toLowerCase()]?.priceUsd
  if (!Number.isFinite(amount) || !Number.isFinite(px as number)) return null
  return amount * (px as number)
}

function formatUsdValue(raw: string, token: string, tokenLookup: Record<string, { symbol: string; name?: string; decimals: number; priceUsd: number | null }>): string {
  const usd = computeUsdValue(raw, token, tokenLookup)
  if (!Number.isFinite(usd as number)) return '—'
  return `$${formatCompactTruncate(usd as number, 2)}`
}

function formatUsdNumber(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `$${formatCompactTruncate(n, 2)}`
}

function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function rankDisplay(rank: number | null, total: number): string {
  if (rank === null) return '—'
  return `#${rank}/${total}`
}

function getSortIndicator(current: SortKey, sortKey: SortKey, dir: 'asc' | 'desc') {
  if (current !== sortKey) return ''
  return dir === 'asc' ? '↑' : '↓'
}

const header = (
  <div style={{ borderBottom: '1px solid #e5e7eb', background: '#ffffff' }}>
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
      <div style={{ fontWeight: 600 }}>Mainnet Analytics</div>
      <nav style={{ display: 'flex', gap: 12 }}>
        <Link to="/">Home</Link>
        <Link to="/trades">Trades</Link>
        <Link to="/competition">Competition</Link>
        <Link to="/order">Order</Link>
        <Link to="/base-trades">Base trades</Link>
      </nav>
      <div />
    </div>
  </div>
)

export default function BaseTradesPage() {
  const [sortKey, setSortKey] = useState<SortKey>('blockNumber')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [sellTokenFilter, setSellTokenFilter] = useState<string>('')
  const [buyTokenFilter, setBuyTokenFilter] = useState<string>('')
  const [pageSize, setPageSize] = useState<number>(50)
  const [page, setPage] = useState<number>(1)

  const tokenLookup = useMemo(() => buildTokenLookup(baseTokens as BaseTokensFile), [])
  const tokenOptions = useMemo(() => {
    return Object.entries(tokenLookup).map(([addr, meta]) => ({
      address: addr,
      symbol: meta.symbol,
      name: meta.name,
    }))
  }, [tokenLookup])

  const trades = useMemo<EnrichedTrade[]>(() => {
    return parseTrades(baseTradesRaw).map((t) => {
      const bids = t.competitionData?.bidData || []
      const winner = bids.find((b) => b.winner) || null
      return {
        ...t,
        targetRank: computeTargetRank(bids),
        winnerAddress: winner?.solverAddress || null,
        winnerBuyAmount: winner?.buyAmount || null,
        bidCount: bids.length,
        sellUsd: computeUsdValue(t.sellAmount, t.sellToken, tokenLookup),
      }
    })
  }, [tokenLookup])

  function tokenMatches(addr: string, filter: string): boolean {
    if (!filter.trim()) return true
    const f = filter.trim().toLowerCase()
    const lc = (addr || '').toLowerCase()
    if (lc.includes(f)) return true
    const meta = tokenLookup[lc]
    if (!meta) return false
    if (meta.symbol?.toLowerCase().includes(f)) return true
    if (meta.name?.toLowerCase().includes(f)) return true
    return false
  }

  const filtered = useMemo(() => {
    return trades.filter((t) => {
      const sellOk = tokenMatches(t.sellToken, sellTokenFilter)
      const buyOk = tokenMatches(t.buyToken, buyTokenFilter)
      return sellOk && buyOk
    })
  }, [trades, sellTokenFilter, buyTokenFilter, tokenLookup])

  const stats = useMemo(() => {
    const totalRows = filtered.length
    let totalVolume = 0
    let pryctoVolumeWon = 0
    let pryctoParticipations = 0
    let pryctoWins = 0
    for (const t of filtered) {
      const vol = Number.isFinite(t.sellUsd as number) ? (t.sellUsd as number) : 0
      totalVolume += vol
      const bids = t.competitionData?.bidData || []
      const hasPrycto = bids.some((b) => (b.solverAddress || '').toLowerCase() === TARGET_SOLVER)
      if (hasPrycto) pryctoParticipations += 1
      const winner = bids.find((b) => b.winner)
      const isPryctoWin = !!winner && (winner.solverAddress || '').toLowerCase() === TARGET_SOLVER
      if (isPryctoWin) {
        pryctoWins += 1
        pryctoVolumeWon += vol
      }
    }
    const participationRate = totalRows > 0 ? pryctoParticipations / totalRows : 0
    const winRate = pryctoParticipations > 0 ? pryctoWins / pryctoParticipations : 0
    const volumeShare = totalVolume > 0 ? pryctoVolumeWon / totalVolume : 0
    return { totalRows, totalVolume, pryctoVolumeWon, pryctoParticipations, pryctoWins, participationRate, winRate, volumeShare }
  }, [filtered])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    const cmpBig = (a: bigint, b: bigint) => {
      if (a === b) return 0
      return a > b ? 1 : -1
    }
    arr.sort((a, b) => {
      let res = 0
      let bothRanksPresent = false
      switch (sortKey) {
        case 'blockNumber':
          res = (a.blockNumber ?? 0) - (b.blockNumber ?? 0)
          break
        case 'sellAmount':
          res = cmpBig(toBig(a.sellAmount), toBig(b.sellAmount))
          break
        case 'buyAmount':
          res = cmpBig(toBig(a.buyAmount), toBig(b.buyAmount))
          break
        case 'sellUsd': {
          const au = a.sellUsd
          const bu = b.sellUsd
          const aNull = au === null || Number.isNaN(au)
          const bNull = bu === null || Number.isNaN(bu)
          if (aNull && bNull) res = 0
          else if (aNull) res = 1
          else if (bNull) res = -1
          else res = (au as number) - (bu as number)
          break
        }
        case 'targetRank': {
          const arNull = a.targetRank === null
          const brNull = b.targetRank === null
          bothRanksPresent = !arNull && !brNull
          if (arNull && brNull) {
            res = 0
          } else if (arNull) {
            res = 1
          } else if (brNull) {
            res = -1
          } else {
            res = (a.targetRank as number) - (b.targetRank as number)
          }
          break
        }
        case 'winnerAddress':
          res = (a.winnerAddress || '').localeCompare(b.winnerAddress || '')
          break
        default:
          res = 0
      }
      const shouldApplyDir = sortKey !== 'targetRank' ? true : bothRanksPresent
      if (!shouldApplyDir) return res
      return sortDir === 'asc' ? res : -res
    })
    return arr
  }, [filtered, sortKey, sortDir, tokenLookup])

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const start = (currentPage - 1) * pageSize
  const pageRows = sorted.slice(start, start + pageSize)

  const toggleSort = (key: SortKey) => {
    setSortKey((prevKey) => {
      if (prevKey !== key) {
        setSortDir('desc')
        setPage(1)
        return key
      }
      setSortDir((prevDir) => (prevDir === 'asc' ? 'desc' : 'asc'))
      return prevKey
    })
  }

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  const baseScanUrl = (tx: string) => `https://basescan.org/tx/${tx}`
  const cowOrderUrl = (uid: string) => `https://explorer.cow.fi/orders/${uid}`

  return (
    <div>
      {header}
      <div style={{ maxWidth: 1200, margin: '0 auto', padding: '1rem' }}>
        <h1>Base trades (local file)</h1>
        <p style={{ color: '#6b7280', marginBottom: 12 }}>
          Loaded {trades.length.toLocaleString()} trades from <code>base-trades.ndjson</code>. Click a row to see full competition bids. Rank column shows
          position of solver {solverLabel(TARGET_SOLVER)} ({TARGET_SOLVER.slice(0, 6)}…{TARGET_SOLVER.slice(-4)}) when bids are sorted by buyAmount (highest first).
        </p>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem', minWidth: 180 }}>
            <div>Total volume (USD)</div>
            <div style={{ fontWeight: 600 }}>{formatUsdNumber(stats.totalVolume)}</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem', minWidth: 180 }}>
            <div>Prycto won volume</div>
            <div style={{ fontWeight: 600 }}>{formatUsdNumber(stats.pryctoVolumeWon)}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{formatPct(stats.volumeShare)} of total</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem', minWidth: 180 }}>
            <div>Prycto participation</div>
            <div style={{ fontWeight: 600 }}>{stats.pryctoParticipations.toLocaleString()} / {stats.totalRows.toLocaleString()}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{formatPct(stats.participationRate)} of trades</div>
          </div>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem', minWidth: 180 }}>
            <div>Prycto win rate</div>
            <div style={{ fontWeight: 600 }}>{formatPct(stats.winRate)}</div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>{stats.pryctoWins.toLocaleString()} wins</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
          <label htmlFor="sell-token-filter">Sell token</label>
          <input
            id="sell-token-filter"
            list="token-suggestions"
            placeholder="symbol / name / address"
            value={sellTokenFilter}
            onChange={(e) => {
              setSellTokenFilter(e.target.value)
              setPage(1)
            }}
            style={{ minWidth: 220 }}
          />
          <label htmlFor="buy-token-filter">Buy token</label>
          <input
            id="buy-token-filter"
            list="token-suggestions"
            placeholder="symbol / name / address"
            value={buyTokenFilter}
            onChange={(e) => {
              setBuyTokenFilter(e.target.value)
              setPage(1)
            }}
            style={{ minWidth: 220 }}
          />
          <datalist id="token-suggestions">
            {tokenOptions.slice(0, 400).map((t) => (
              <option key={t.address} value={t.symbol || t.address}>
                {t.symbol ? `${t.symbol} — ${t.address}` : t.address}
              </option>
            ))}
          </datalist>
          <span style={{ flexGrow: 1 }} />
          <label htmlFor="page-size">Rows per page</label>
          <select
            id="page-size"
            value={pageSize}
            onChange={(e) => {
              const next = Number(e.target.value) || 50
              setPageSize(next)
              setPage(1)
            }}
          >
            {[25, 50, 100, 200].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
              style={{ padding: '4px 8px' }}
            >
              Prev
            </button>
            <div style={{ minWidth: 120, textAlign: 'center' }}>
              Page {currentPage} / {totalPages} ({sorted.length.toLocaleString()} rows)
            </div>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={currentPage >= totalPages}
              style={{ padding: '4px 8px' }}
            >
              Next
            </button>
          </div>
        </div>
        <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50" style={{ cursor: 'pointer' }} onClick={() => toggleSort('blockNumber')}>
                Block {getSortIndicator('blockNumber', sortKey, sortDir)}
              </th>
              <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Order UID</th>
              <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Tx</th>
              <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50" style={{ cursor: 'pointer' }} onClick={() => toggleSort('sellAmount')}>
                Sell {getSortIndicator('sellAmount', sortKey, sortDir)}
              </th>
              <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50" style={{ cursor: 'pointer' }} onClick={() => toggleSort('buyAmount')}>
                Buy {getSortIndicator('buyAmount', sortKey, sortDir)}
              </th>
              <th
                className="px-3 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50"
                style={{ cursor: 'pointer', paddingRight: 18 }}
                onClick={() => toggleSort('sellUsd')}
              >
                Sell value (USD) {getSortIndicator('sellUsd', sortKey, sortDir)}
              </th>
              <th
                className="px-3 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50"
                style={{ cursor: 'pointer', paddingLeft: 18 }}
                onClick={() => toggleSort('winnerAddress')}
              >
                Winner {getSortIndicator('winnerAddress', sortKey, sortDir)}
              </th>
              <th className="px-3 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50" style={{ cursor: 'pointer' }} onClick={() => toggleSort('targetRank')}>
                Target rank {getSortIndicator('targetRank', sortKey, sortDir)}
              </th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((t) => {
              const isOpen = !!expanded[t.orderUid]
              return (
                <Fragment key={t.orderUid}>
                  <tr className="odd:bg-white even:bg-gray-50" onClick={() => toggleExpanded(t.orderUid)} style={{ cursor: 'pointer' }} aria-expanded={isOpen}>
                    <td className="px-3 py-2 border-b">{t.blockNumber}</td>
                    <td className="px-3 py-2 border-b" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <a href={cowOrderUrl(t.orderUid)} target="_blank" rel="noreferrer" title={t.orderUid} onClick={(e) => e.stopPropagation()}>
                        {t.orderUid.slice(0, 6)}…{t.orderUid.slice(-6)}
                      </a>
                    </td>
                    <td className="px-3 py-2 border-b" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <a href={baseScanUrl(t.transactionHash)} target="_blank" rel="noreferrer" title={t.transactionHash} onClick={(e) => e.stopPropagation()}>
                        {t.transactionHash.slice(0, 6)}…{t.transactionHash.slice(-4)}
                      </a>
                    </td>
                    <td className="px-3 py-2 border-b" title={`${t.sellAmount} (raw)`}>
                      {formatTokenAmount(t.sellAmount, t.sellToken, tokenLookup)}
                    </td>
                    <td className="px-3 py-2 border-b" title={`${t.buyAmount} (raw)`}>
                      {formatTokenAmount(t.buyAmount, t.buyToken, tokenLookup)}
                    </td>
                    <td className="px-3 py-2 border-b text-right" style={{ paddingRight: 18 }}>
                      {formatUsdValue(t.sellAmount, t.sellToken, tokenLookup)}
                    </td>
                    <td className="px-3 py-2 border-b" style={{ paddingLeft: 18 }} title={t.winnerAddress || 'Unknown'}>
                      {t.winnerAddress ? solverLabel(t.winnerAddress) : '—'}
                    </td>
                    <td className="px-3 py-2 border-b text-right">{rankDisplay(t.targetRank, t.bidCount)}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td className="px-3 py-2 border-b bg-gray-50" colSpan={8}>
                        {t.competitionData?.bidData && t.competitionData.bidData.length > 0 ? (
                          <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
                            <thead>
                              <tr>
                                <th className="px-2 py-1 text-left text-xs font-semibold text-gray-700 border-b">Rank</th>
                                <th className="px-2 py-1 text-left text-xs font-semibold text-gray-700 border-b">Solver</th>
                                <th className="px-2 py-1 text-left text-xs font-semibold text-gray-700 border-b">Sell bid</th>
                                <th className="px-2 py-1 text-left text-xs font-semibold text-gray-700 border-b">Buy bid</th>
                                <th className="px-2 py-1 text-left text-xs font-semibold text-gray-700 border-b">Winner</th>
                              </tr>
                            </thead>
                            <tbody>
                              {[...t.competitionData.bidData]
                                .sort((a, b) => {
                                  const diff = toBig(b.buyAmount) - toBig(a.buyAmount)
                                  if (diff === 0n) return 0
                                  return diff > 0n ? 1 : -1
                                })
                                .map((b, idx) => {
                                  const isWinner = !!b.winner
                                  const isTarget = (b.solverAddress || '').toLowerCase() === TARGET_SOLVER
                                  return (
                                    <tr
                                      key={`${t.orderUid}-bid-${idx}`}
                                      className="odd:bg-white even:bg-gray-50"
                                      style={{
                                        backgroundColor: isWinner ? '#ecfdf5' : isTarget ? '#eef2ff' : undefined,
                                        fontWeight: isWinner ? 600 : undefined,
                                      }}
                                    >
                                      <td className="px-2 py-1 border-b">{idx + 1}</td>
                                      <td className="px-2 py-1 border-b" title={b.solverAddress}>
                                        {solverLabel(b.solverAddress)}
                                      </td>
                                      <td className="px-2 py-1 border-b">{formatTokenAmount(b.sellAmount, t.sellToken, tokenLookup)}</td>
                                      <td className="px-2 py-1 border-b">{formatTokenAmount(b.buyAmount, t.buyToken, tokenLookup)}</td>
                                      <td className="px-2 py-1 border-b">{isWinner ? 'Yes' : 'No'}</td>
                                    </tr>
                                  )
                                })}
                            </tbody>
                          </table>
                        ) : (
                          <div style={{ color: '#6b7280' }}>No competition data.</div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

