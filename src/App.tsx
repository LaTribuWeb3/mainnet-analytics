import { useEffect, useState } from 'react'
import type { TradesApiResponse } from './types'
import { getMissingTradeFields, isTradeDocument } from './utils/guards'
import { splitTradesBySellValueUsd } from './utils/buckets'
import type { TradeBuckets } from './utils/buckets'

const DATA_URL = 'https://prod.mainnet.cowswap.la-tribu.xyz/db/USDC-WETH'
const CACHE_KEY = 'usdc-weth-trades-cache-v1'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

type CacheEntry = { data: TradesApiResponse; cachedAt: number }
function isCacheEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return 'data' in obj && 'cachedAt' in obj && typeof obj.cachedAt === 'number'
}

export default function App() {
  const [buckets, setBuckets] = useState<TradeBuckets | null>(null)
  const [missingCounts, setMissingCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    const abortController = new AbortController()

    function processResponse(json: TradesApiResponse) {
      const missingCounter: Record<string, number> = {}
      const filtered = json.documents.filter((doc) => {
        if (isTradeDocument(doc)) return true
        const missing = getMissingTradeFields(doc)
        for (const key of missing) missingCounter[key] = (missingCounter[key] ?? 0) + 1
        return false
      })
      const newBuckets = splitTradesBySellValueUsd(filtered)
      setBuckets(newBuckets)
      setMissingCounts(missingCounter)
    }

    async function fetchData() {
      try {
        const response = await fetch(DATA_URL, { signal: abortController.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const json: TradesApiResponse = await response.json()
        console.log('JSON:', json)
        // Always render, even if caching fails
        processResponse(json)
        try {
          localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({ data: json, cachedAt: Date.now() })
          )
        } catch (cacheError) {
          console.warn('Failed to cache response (likely quota exceeded):', cacheError)
        }
      } catch (error) {
        if ((error as { name?: string } | null)?.name !== 'AbortError') {
          console.error('Failed to fetch data:', error)
        }
      }
    }

    try {
      const cached = localStorage.getItem(CACHE_KEY)
      if (cached) {
        const parsedUnknown: unknown = JSON.parse(cached)
        if (isCacheEntry(parsedUnknown)) {
          const entry = parsedUnknown
          const isFresh = Date.now() - entry.cachedAt < CACHE_TTL_MS
          if (isFresh) {
            console.log('Loaded fresh cache')
            processResponse(entry.data)
          } else {
            console.log('Loaded stale cache, will refresh')
            processResponse(entry.data)
            fetchData()
          }
          return () => abortController.abort()
        } else {
          // Backward compatibility for older cache value
          const legacy = parsedUnknown as TradesApiResponse
          console.log('Loaded legacy cache, will refresh')
          processResponse(legacy)
          fetchData()
          return () => abortController.abort()
        }
      }
    } catch (e) {
      console.warn('Failed to load cache:', e)
    }

    fetchData()
    return () => abortController.abort()
  }, [])

  return buckets === null ? (
    <div>
      <h1>Hello world</h1>
      <p>Loading data…</p>
    </div>
  ) : (
    <div>
      <h1>Hello world</h1>
      <table>
        <thead>
          <tr>
            <th>Bucket</th>
            <th>Orders</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>0 - 1k</td>
            <td>{buckets.b0_1k.length}</td>
          </tr>
          <tr>
            <td>1k - 5k</td>
            <td>{buckets.b1k_5k.length}</td>
          </tr>
          <tr>
            <td>5k - 20k</td>
            <td>{buckets.b5k_20k.length}</td>
          </tr>
          <tr>
            <td>20k - 50k</td>
            <td>{buckets.b20k_50k.length}</td>
          </tr>
          <tr>
            <td>50k - 100k</td>
            <td>{buckets.b50k_100k.length}</td>
          </tr>
          <tr>
            <td>100k - 500k</td>
            <td>{buckets.b100k_500k.length}</td>
          </tr>
          <tr>
            <td>500k - 5m</td>
            <td>{buckets.b500k_5m.length}</td>
          </tr>
          <tr>
            <td>5m+</td>
            <td>{buckets.b5m_plus.length}</td>
          </tr>
        </tbody>
      </table>

      <h2>Missing fields (excluded documents)</h2>
      {Object.keys(missingCounts).length === 0 ? (
        <p>None</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Missing count</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(missingCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([field, count]) => (
                <tr key={field}>
                  <td>{field}</td>
                  <td>{count}</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  )
}


