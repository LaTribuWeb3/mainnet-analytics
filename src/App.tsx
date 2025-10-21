import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatUSDCCompact } from './utils/format'
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
  const [rawResponse, setRawResponse] = useState<TradesApiResponse | null>(null)
  const [timeSpan, setTimeSpan] = useState<'yesterday' | 'last7' | 'last30'>('yesterday')
  const showMissing = false

  const processResponse = useCallback(
    (json: TradesApiResponse, span: 'yesterday' | 'last7' | 'last30') => {
      const now = new Date()
      const endSec = Math.floor(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
      )
      const day = 24 * 60 * 60
      const startSec =
        span === 'yesterday'
          ? endSec - day
          : span === 'last7'
          ? endSec - 7 * day
          : endSec - 30 * day
      const inRange = json.documents.filter((doc) => {
        const tsRaw = (doc as unknown as { blockTimestamp?: number | string | null }).blockTimestamp
        const ts = typeof tsRaw === 'string' ? Number(tsRaw) : tsRaw
        if (!Number.isFinite(ts)) return false
        return (ts as number) >= startSec && (ts as number) < endSec
      })

      const missingCounter: Record<string, number> = {}
      const valid = inRange.filter((doc) => {
        if (isTradeDocument(doc)) return true
        const missing = getMissingTradeFields(doc)
        for (const key of missing) missingCounter[key] = (missingCounter[key] ?? 0) + 1
        return false
      })

      const newBuckets = splitTradesBySellValueUsd(valid)
      setBuckets(newBuckets)
      setMissingCounts(missingCounter)
    },
    []
  )

  const volumes = useMemo(() => {
    if (!buckets) return null
    const sum = (arr: { orderSellValueUsd: number | string }[]) =>
      arr.reduce((acc, t) => {
        const v = typeof t.orderSellValueUsd === 'string' ? Number(t.orderSellValueUsd) : t.orderSellValueUsd
        return Number.isFinite(v) ? acc + (v as number) : acc
      }, 0)
    return {
      b0_1k: sum(buckets.b0_1k),
      b1k_5k: sum(buckets.b1k_5k),
      b5k_20k: sum(buckets.b5k_20k),
      b20k_50k: sum(buckets.b20k_50k),
      b50k_100k: sum(buckets.b50k_100k),
      b100k_500k: sum(buckets.b100k_500k),
      b500k_5m: sum(buckets.b500k_5m),
      b5m_plus: sum(buckets.b5m_plus),
    }
  }, [buckets])

  const premiums = useMemo(() => {
    if (!buckets) return null
    const avg = (arr: { rateDiffBps: number | string }[]) => {
      let sum = 0
      let count = 0
      for (const t of arr) {
        const v = typeof t.rateDiffBps === 'string' ? Number(t.rateDiffBps) : t.rateDiffBps
        if (Number.isFinite(v)) {
          sum += v as number
          count += 1
        }
      }
      return count > 0 ? sum / count : null
    }
    return {
      b0_1k: avg(buckets.b0_1k),
      b1k_5k: avg(buckets.b1k_5k),
      b5k_20k: avg(buckets.b5k_20k),
      b20k_50k: avg(buckets.b20k_50k),
      b50k_100k: avg(buckets.b50k_100k),
      b100k_500k: avg(buckets.b100k_500k),
      b500k_5m: avg(buckets.b500k_5m),
      b5m_plus: avg(buckets.b5m_plus),
    }
  }, [buckets])

  const totals = useMemo(() => {
    if (!buckets) return null
    const totalOrders =
      buckets.b0_1k.length +
      buckets.b1k_5k.length +
      buckets.b5k_20k.length +
      buckets.b20k_50k.length +
      buckets.b50k_100k.length +
      buckets.b100k_500k.length +
      buckets.b500k_5m.length +
      buckets.b5m_plus.length
    const totalVolume = volumes
      ? volumes.b0_1k +
        volumes.b1k_5k +
        volumes.b5k_20k +
        volumes.b20k_50k +
        volumes.b50k_100k +
        volumes.b100k_500k +
        volumes.b500k_5m +
        volumes.b5m_plus
      : 0
    return { totalOrders, totalVolume }
  }, [buckets, volumes])

  useEffect(() => {
    const abortController = new AbortController()


    async function fetchData() {
      try {
        const response = await fetch(DATA_URL, { signal: abortController.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const json: TradesApiResponse = await response.json()
        console.log('JSON:', json)
        setRawResponse(json)
        // Always render, even if caching fails
        // Processing is triggered by the rawResponse/timeSpan effect
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
            setRawResponse(entry.data)
          } else {
            console.log('Loaded stale cache, will refresh')
            setRawResponse(entry.data)
            fetchData()
          }
          return () => abortController.abort()
        } else {
          // Backward compatibility for older cache value
          const legacy = parsedUnknown as TradesApiResponse
          console.log('Loaded legacy cache, will refresh')
          setRawResponse(legacy)
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

  useEffect(() => {
    if (rawResponse) {
      processResponse(rawResponse, timeSpan)
    }
  }, [timeSpan, rawResponse, processResponse])

  return buckets === null ? (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
      <h1>Hello world</h1>
      <p>Loading data…</p>
    </div>
  ) : (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
      <div>
        <label htmlFor="timespan">Time span: </label>
        <select
          id="timespan"
          value={timeSpan}
          onChange={(e) => setTimeSpan(e.target.value as 'yesterday' | 'last7' | 'last30')}
        >
          <option value="yesterday">Yesterday</option>
          <option value="last7">Last 7 days</option>
          <option value="last30">Last 30 days</option>
        </select>
      </div>

      <div style={{ display: 'flex', gap: '1rem' }}>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem' }}>
          <div>Total valid orders</div>
          <div>{totals ? totals.totalOrders.toLocaleString() : 0}</div>
        </div>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem' }}>
          <div>Total volume (USD)</div>
          <div>{totals ? `$${formatUSDCCompact(totals.totalVolume)}` : '$0'}</div>
        </div>
      </div>

      <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Bucket</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Orders</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Volume USD</th>
            <th
              className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50"
              title={
                'Execution premium vs market (bps) — positive = solver price is lower than market, negative = higher.\n' +
                'Price slippage vs market (bps), Rate delta to market (bps).\n' +
                'Definition: bps = (execution_rate − market_rate) / market_rate × 10,000.'
              }
            >
              Execution premium average (bps)
            </th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Share of total volume</th>
          </tr>
        </thead>
        <tbody>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">0 - 1k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b0_1k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b0_1k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b0_1k !== null ? (premiums.b0_1k as number).toFixed(1) : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b0_1k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">1k - 5k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b1k_5k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b1k_5k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b1k_5k !== null ? (premiums.b1k_5k as number).toFixed(1) : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b1k_5k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5k - 20k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b5k_20k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b5k_20k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b5k_20k !== null ? (premiums.b5k_20k as number).toFixed(1) : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b5k_20k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">20k - 50k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b20k_50k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b20k_50k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b20k_50k !== null ? (premiums.b20k_50k as number).toFixed(1) : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b20k_50k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">50k - 100k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b50k_100k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b50k_100k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b50k_100k !== null ? (premiums.b50k_100k as number).toFixed(1) : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b50k_100k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">100k - 500k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b100k_500k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b100k_500k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b100k_500k !== null ? (premiums.b100k_500k as number).toFixed(1) : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b100k_500k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">500k - 5m</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b500k_5m.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b500k_5m)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b500k_5m !== null ? (premiums.b500k_5m as number).toFixed(1) : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b500k_5m / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5m+</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b5m_plus.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b5m_plus)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b5m_plus !== null ? (premiums.b5m_plus as number).toFixed(1) : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b5m_plus / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
          </tr>
        </tbody>
      </table>

      {showMissing && (
        <>
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
        </>
      )}
    </div>
  )
}


