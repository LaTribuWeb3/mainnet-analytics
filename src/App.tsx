import { useEffect, useRef } from 'react'
import type { TradeDocument, TradesApiResponse } from './types'
import { isTradeDocument } from './utils/guards'
import { splitTradesBySellValueUsd } from './utils/buckets'

const DATA_URL = 'https://prod.mainnet.cowswap.la-tribu.xyz/db/USDC-WETH'

export default function App() {
  const dataRef = useRef<TradeDocument[] | null>(null)
  const b0_1kRef = useRef<TradeDocument[] | null>(null)
  const b1k_5kRef = useRef<TradeDocument[] | null>(null)
  const b5k_20kRef = useRef<TradeDocument[] | null>(null)
  const b20k_50kRef = useRef<TradeDocument[] | null>(null)
  const b50k_100kRef = useRef<TradeDocument[] | null>(null)
  const b100k_500kRef = useRef<TradeDocument[] | null>(null)
  const b500k_5mRef = useRef<TradeDocument[] | null>(null)
  const b5m_plusRef = useRef<TradeDocument[] | null>(null)

  useEffect(() => {
    const abortController = new AbortController()

    async function fetchData() {
      try {
        const response = await fetch(DATA_URL, { signal: abortController.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const json: TradesApiResponse = await response.json()
        const filtered = json.documents.filter(isTradeDocument)
        dataRef.current = filtered
        const buckets = splitTradesBySellValueUsd(filtered)
        b0_1kRef.current = buckets.b0_1k
        b1k_5kRef.current = buckets.b1k_5k
        b5k_20kRef.current = buckets.b5k_20k
        b20k_50kRef.current = buckets.b20k_50k
        b50k_100kRef.current = buckets.b50k_100k
        b100k_500kRef.current = buckets.b100k_500k
        b500k_5mRef.current = buckets.b500k_5m
        b5m_plusRef.current = buckets.b5m_plus
        console.log('Buckets:', buckets)
      } catch (error) {
        if ((error as { name?: string } | null)?.name !== 'AbortError') {
          console.error('Failed to fetch data:', error)
        }
      }
    }

    fetchData()
    return () => abortController.abort()
  }, [])

  return <div>Hello world</div>
}


