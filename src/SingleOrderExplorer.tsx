import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { BidDatum, TradeDocument, TradesApiResponse } from './types'
import { normalizeAmount } from './utils/price'
import { formatCompactTruncate } from './utils/format'
 

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
  pryctoPricingMetadata?: TradeDocument['pryctoPricingMetadata']
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
    blockTimestamp: tsNum as number,
    buyAmount: item.buyAmount,
    buyToken: item.buyToken,
    owner: item.owner,
    sellAmount: item.sellAmount,
    sellToken: item.sellToken,
    cowswapFeeAmount: BigInt(String(item.cowswapFeeAmount ?? '0')),
    competitionData: bids.length > 0 ? { bidData: bids } : undefined,
    binancePrices: item.binancePrices,
    pryctoPricingMetadata: item.pryctoPricingMetadata,
  }
}

export default function SingleOrderExplorer() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [document, setDocument] = useState<TradeDocument | null>(null)
  const initialUid = searchParams.get('uid') || ''
  const initialTx = searchParams.get('tx') || ''
  const [idType, setIdType] = useState<'orderUid' | 'transactionHash'>(initialTx ? 'transactionHash' : 'orderUid')
  const [orderUid, setOrderUid] = useState<string>(initialTx || initialUid)

  

  useEffect(() => {
    if (!orderUid) {
      setDocument(null)
      setError(null)
      return
    }
    const abort = new AbortController()
    async function load() {
      try {
        setLoading(true)
        setError(null)
        const apiBase = 'https://cowswap-data-api.la-tribu.xyz'
        const url = new URL(apiBase + API_PATH, window.location.origin)
        url.searchParams.set(idType, orderUid)
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
        console.log('SingleOrderExplorer API url', url.toString())
        console.log('SingleOrderExplorer order (raw)', (items as ApiItem[])[0])
        console.log('SingleOrderExplorer order (mapped)', mapped[0])
        setDocument(mapped[0] || null)
      } catch (e) {
        if ((e as { name?: string } | null)?.name === 'AbortError') return
        setError((e as Error).message)
        setDocument(null)
      } finally {
        setLoading(false)
      }
    }
    load()
    return () => abort.abort()
  }, [orderUid, idType])

  useEffect(() => {
    const currentUid = searchParams.get('uid') || ''
    const currentTx = searchParams.get('tx') || ''
    const next: Record<string, string> = {}
    if (idType === 'orderUid') {
      if (orderUid) next.uid = orderUid
    } else {
      if (orderUid) next.tx = orderUid
    }
    const differs = (idType === 'orderUid' ? currentUid : currentTx) !== (orderUid || '') || (idType === 'orderUid' ? !!currentTx : !!currentUid)
    if (differs) setSearchParams(next)
  }, [orderUid, idType, searchParams, setSearchParams])

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

  const header = (
    <div style={{ borderBottom: '1px solid #e5e7eb', background: '#ffffff' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ fontWeight: 600 }}>Mainnet Analytics</div>
        <nav style={{ display: 'flex', gap: 12 }}>
          <Link to="/">Home</Link>
          <Link to="/trades">Trades</Link>
          <Link to="/competition">Competition</Link>
          <Link to="/order">Order</Link>
        </nav>
        <div />
      </div>
    </div>
  )

  return (
    <div>
      {header}
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
        <h1>Single Order Explorer</h1>
        <div style={{ marginTop: '0.75rem', marginBottom: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="id-type">Identifier</label>
          <select id="id-type" value={idType} onChange={(e) => setIdType(e.target.value as 'orderUid' | 'transactionHash')}>
            <option value="orderUid">Order UID</option>
            <option value="transactionHash">Transaction Hash</option>
          </select>
          <label htmlFor="order-uid">{idType === 'orderUid' ? 'Order UID' : 'Transaction Hash'}</label>
          <input
            id="order-uid"
            type="text"
            placeholder="0x..."
            value={orderUid}
            onChange={(e) => setOrderUid(e.target.value)}
            style={{ width: 360 }}
          />
          {idType === 'orderUid' ? (
            <a href={orderUid ? cowOrderUrl(orderUid) : undefined} target="_blank" rel="noreferrer" onClick={(e) => { if (!orderUid) e.preventDefault() }}>
              Open in Cow Explorer ↗
            </a>
          ) : (
            <a href={orderUid ? etherscanTxUrl(orderUid) : undefined} target="_blank" rel="noreferrer" onClick={(e) => { if (!orderUid) e.preventDefault() }}>
              Open in Etherscan ↗
            </a>
          )}
        </div>
        {loading ? (
          <p>Loading…</p>
        ) : error ? (
          <p style={{ color: '#dc2626' }}>Error: {error}</p>
        ) : !document ? (
          <div style={{ color: '#6b7280' }}>Enter an Order UID to load details.</div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
                <div>Order UID</div>
                <div style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>{document.orderUid}</div>
              </div>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
                <div>Tx</div>
                <div style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <a href={etherscanTxUrl(document.txHash)} target="_blank" rel="noreferrer">{document.txHash}</a>
                </div>
              </div>
            </div>

            <h2 style={{ marginTop: '1rem', marginBottom: '0.5rem', fontWeight: 600 }}>Order overview</h2>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
                  <div>Sell</div>
                  <div>{formatTokenAmount(document.sellAmount, document.sellToken)}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{document.sellAmount}</div>
                </div>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
                  <div>Buy token target</div>
                  <div>{tokenSymbol(document.buyToken)}</div>
                </div>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
                  <div>Obtained</div>
                  <div>{(() => {
                    const winner = document.competitionData?.bidData?.find?.((b) => b?.winner)
                    if (!winner) return '-'
                    return formatTokenAmount(winner.buyAmount, document.buyToken)
                  })()}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{(() => {
                    const winner = document.competitionData?.bidData?.find?.((b) => b?.winner)
                    return winner ? winner.buyAmount : '-'
                  })()}</div>
                </div>
              </div>
            </div>

            <h2 style={{ marginTop: '1rem', marginBottom: '0.5rem', fontWeight: 600 }}>Prycto Parameters</h2>
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem' }}>
              {document.pryctoPricingMetadata ? (
                <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                  
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem', minWidth: 200 }}>
                    <div title={
                      'Time between Prycto quote time and on-chain execution block time.\n' +
                      'Computed as |(blockTimestamp × 1000) − quotedAtMs|.\n' +
                      'quotedAtMs from pryctoPricingMetadata; blockTimestamp from the trade document.'
                    }>Execution latency</div>
                    <div>{(() => {
                      const meta = document.pryctoPricingMetadata as { quotedAtMs?: number }
                      const quotedAtMs = typeof meta?.quotedAtMs === 'number' ? meta.quotedAtMs : null
                      const blockMs = Number.isFinite(document.blockTimestamp) ? (document.blockTimestamp as number) * 1000 : null
                      if (quotedAtMs === null || blockMs === null) return '-'
                      const diffMs = Math.abs(blockMs - quotedAtMs)
                      if (!Number.isFinite(diffMs)) return '-'
                      if (diffMs >= 1000) return `${(diffMs / 1000).toFixed(2)} s`
                      return `${diffMs.toFixed(0)} ms`
                    })()}</div>
                  </div>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem', minWidth: 240 }}>
                    <div title={'Raw values as quoted by Prycto at quote time.\nImplied price = amountInHuman / otherAmountHuman.'}>Raw Prycto data</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>amountInHuman</div>
                    <div>{(() => {
                      const meta = document.pryctoPricingMetadata as { amountInHuman?: number }
                      const v = typeof meta?.amountInHuman === 'number' ? meta.amountInHuman : null
                      if (v === null) return '-'
                      const s = (v as number).toFixed(8).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1')
                      return s
                    })()}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>otherAmountHuman</div>
                    <div>{(() => {
                      const meta = document.pryctoPricingMetadata as { otherAmountHuman?: number }
                      const v = typeof meta?.otherAmountHuman === 'number' ? meta.otherAmountHuman : null
                      if (v === null) return '-'
                      const s = (v as number).toFixed(8).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1')
                      return s
                    })()}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>implied price</div>
                    <div>{(() => {
                      const meta = document.pryctoPricingMetadata as { amountInHuman?: number; otherAmountHuman?: number }
                      const a = typeof meta?.amountInHuman === 'number' ? meta.amountInHuman : null
                      const b = typeof meta?.otherAmountHuman === 'number' ? meta.otherAmountHuman : null
                      if (a === null || b === null || b === 0) return '-'
                      const p = a / b
                      const s = p.toFixed(8).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1')
                      return s
                    })()}</div>
                  </div>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem', minWidth: 240 }}>
                    <div title={'Buy token USD price references.\nExecution = buyTokenInUSD at block time.\nQuote = buyTokenInUSDBinanceAtQuoted from Prycto metadata.'}>Market data</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Buy token at execution (USD)</div>
                    <div>{(() => {
                      const px = Number((document.binancePrices as { buyTokenInUSD?: number } | undefined)?.buyTokenInUSD)
                      return Number.isFinite(px) ? px.toFixed(6) : '-'
                    })()}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>Buy token at quote (USD)</div>
                    <div>{(() => {
                      const meta = document.pryctoPricingMetadata as { buyTokenInUSDBinanceAtQuoted?: number } | undefined
                      const px = typeof meta?.buyTokenInUSDBinanceAtQuoted === 'number' ? meta!.buyTokenInUSDBinanceAtQuoted : null
                      return px === null ? '-' : (px as number).toFixed(6)
                    })()}</div>
                  </div>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem', minWidth: 200 }}>
                    <div>Solver Data:</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>Solver Configured Margin</div>
                    <div>{(() => {
                      const meta = document.pryctoPricingMetadata as { marginBps?: number }
                      const v = typeof meta?.marginBps === 'number' ? meta.marginBps : null
                      return v === null ? '-' : `${v} bps`
                    })()}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>priceOffered (aligned buy/sell)</div>
                    <div>{(() => {
                      const meta = document.pryctoPricingMetadata as { priceOffered?: number; amountInHuman?: number; otherAmountHuman?: number }
                      const offered = typeof meta?.priceOffered === 'number' ? meta.priceOffered : null
                      const a = typeof meta?.amountInHuman === 'number' ? meta.amountInHuman : null
                      const b = typeof meta?.otherAmountHuman === 'number' ? meta.otherAmountHuman : null
                      if (offered === null) return '-'
                      // Align offered to buy-per-sell orientation if quote data available
                      let aligned = offered
                      if (a !== null && b !== null && a !== 0 && b !== 0) {
                        const implied = a / b
                        const relOffered = Math.abs((offered - implied) / implied)
                        const inv = offered !== 0 ? 1 / offered : NaN
                        const relInv = Number.isFinite(inv) && implied !== 0 ? Math.abs((inv - implied) / implied) : Number.POSITIVE_INFINITY
                        aligned = relInv < relOffered && Number.isFinite(inv) ? inv : offered
                      }
                      const s = aligned.toFixed(8).replace(/\.0+$/, '').replace(/(\.[0-9]*?)0+$/, '$1')
                      return s
                    })()}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>Δ vs implied (bps)</div>
                    <div>{(() => {
                      const meta = document.pryctoPricingMetadata as { priceOffered?: number; amountInHuman?: number; otherAmountHuman?: number }
                      const offered = typeof meta?.priceOffered === 'number' ? meta.priceOffered : null
                      const a = typeof meta?.amountInHuman === 'number' ? meta.amountInHuman : null
                      const b = typeof meta?.otherAmountHuman === 'number' ? meta.otherAmountHuman : null
                      if (offered === null || a === null || b === null || a === 0 || b === 0) return '-'
                      const implied = a / b
                      // Align offered (invert if closer) to buy-per-sell before diff
                      const inv = offered !== 0 ? 1 / offered : NaN
                      const relOffered = Math.abs((offered - implied) / implied)
                      const relInv = Number.isFinite(inv) ? Math.abs((inv - implied) / implied) : Number.POSITIVE_INFINITY
                      const offeredAligned = relInv < relOffered && Number.isFinite(inv) ? inv : offered
                      if (!Number.isFinite(implied) || implied === 0) return '-'
                      const bps = ((offeredAligned - implied) / implied) * 10000
                      return bps.toFixed(1)
                    })()}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>Δ vs market at execution (bps)</div>
                    <div>{(() => {
                      const meta = document.pryctoPricingMetadata as { priceOffered?: number; amountInHuman?: number; otherAmountHuman?: number }
                      const offered = typeof meta?.priceOffered === 'number' ? meta.priceOffered : null
                      const a = typeof meta?.amountInHuman === 'number' ? meta.amountInHuman : null
                      const b = typeof meta?.otherAmountHuman === 'number' ? meta.otherAmountHuman : null
                      const buyExec = Number((document.binancePrices as { buyTokenInUSD?: number } | undefined)?.buyTokenInUSD)
                      const sellExec = Number((document.binancePrices as { sellTokenInUSD?: number } | undefined)?.sellTokenInUSD)
                      if (offered === null || a === null || b === null || a === 0 || b === 0) return '-'
                      if (!Number.isFinite(buyExec) || !Number.isFinite(sellExec) || buyExec === 0) return '-'
                      const marketExec = sellExec / buyExec // buy per sell
                      const inv = offered !== 0 ? 1 / offered : NaN
                      const implied = a / b
                      const relOff = Math.abs((offered - implied) / implied)
                      const relInv = Number.isFinite(inv) ? Math.abs((inv - implied) / implied) : Number.POSITIVE_INFINITY
                      const offeredAligned = relInv < relOff && Number.isFinite(inv) ? inv : offered
                      const bps = ((offeredAligned - marketExec) / marketExec) * 10000
                      return Number.isFinite(bps) ? bps.toFixed(1) : '-'
                    })()}</div>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>Δ vs market at quote (bps)</div>
                    <div>{(() => {
                      const meta = document.pryctoPricingMetadata as { priceOffered?: number; amountInHuman?: number; otherAmountHuman?: number; buyTokenInUSDBinanceAtQuoted?: number; sellTokenInUSDBinanceAtQuoted?: number }
                      const offered = typeof meta?.priceOffered === 'number' ? meta.priceOffered : null
                      const a = typeof meta?.amountInHuman === 'number' ? meta.amountInHuman : null
                      const b = typeof meta?.otherAmountHuman === 'number' ? meta.otherAmountHuman : null
                      const buyQ = typeof meta?.buyTokenInUSDBinanceAtQuoted === 'number' ? meta.buyTokenInUSDBinanceAtQuoted : null
                      const sellQ = typeof meta?.sellTokenInUSDBinanceAtQuoted === 'number' ? meta.sellTokenInUSDBinanceAtQuoted : null
                      if (offered === null || a === null || b === null || a === 0 || b === 0) return '-'
                      if (buyQ === null || sellQ === null || buyQ === 0) return '-'
                      const marketQ = sellQ / buyQ // buy per sell
                      const inv = offered !== 0 ? 1 / offered : NaN
                      const implied = a / b
                      const relOff = Math.abs((offered - implied) / implied)
                      const relInv = Number.isFinite(inv) ? Math.abs((inv - implied) / implied) : Number.POSITIVE_INFINITY
                      const offeredAligned = relInv < relOff && Number.isFinite(inv) ? inv : offered
                      const bps = ((offeredAligned - marketQ) / marketQ) * 10000
                      return Number.isFinite(bps) ? bps.toFixed(1) : '-'
                    })()}</div>
                  </div>
                </div>
              ) : (
                <div style={{ color: '#6b7280' }}>No Prycto pricing metadata found for this order.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}


