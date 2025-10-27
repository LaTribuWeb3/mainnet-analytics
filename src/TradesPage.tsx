import { useEffect, useMemo, useState } from 'react'
import type { BidDatum, TradeDocument, TradesApiResponse } from './types'

const API_URL = '/api/trades'

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

  useEffect(() => {
    const abort = new AbortController()
    async function load() {
      try {
        setLoading(true)
        setError(null)
        const res = await fetch(API_URL, { signal: abort.signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
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
  }, [])

  const summary = useMemo(() => {
    return {
      count: documents.length,
      uniqueOwners: new Set(documents.map((d) => d.owner.toLowerCase())).size,
    }
  }, [documents])

  if (loading) {
    return (
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
        <h1>Trades (Cowswap Data API)</h1>
        <p>Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
        <h1>Trades (Cowswap Data API)</h1>
        <p style={{ color: '#dc2626' }}>Error: {error}</p>
      </div>
    )
  }

  return (
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

      <h2 style={{ marginTop: '1rem', marginBottom: '0.5rem', fontWeight: 600 }}>Latest trades</h2>
      <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Order UID</th>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Tx</th>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Sell</th>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Buy</th>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Winner</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Block</th>
          </tr>
        </thead>
        <tbody>
          {documents.slice(0, 50).map((d) => {
            const winner = d.competitionData?.bidData?.find((b) => b.winner)
            return (
              <tr key={d._id} className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.orderUid}</td>
                <td className="px-4 py-2 border-b" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.txHash}</td>
                <td className="px-4 py-2 border-b" title={d.sellToken}>{d.sellAmount}</td>
                <td className="px-4 py-2 border-b" title={d.buyToken}>{d.buyAmount}</td>
                <td className="px-4 py-2 border-b" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>{winner?.solverAddress || '-'}</td>
                <td className="px-4 py-2 border-b text-right">{d.blockNumber}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}


