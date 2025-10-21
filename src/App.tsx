import { useEffect, useState } from 'react'
import type { TradesApiResponse } from './types'
import { getMissingTradeFields, isTradeDocument } from './utils/guards'
import { splitTradesBySellValueUsd } from './utils/buckets'
import type { TradeBuckets } from './utils/buckets'

const DATA_URL = 'https://prod.mainnet.cowswap.la-tribu.xyz/db/USDC-WETH'

export default function App() {
  const [buckets, setBuckets] = useState<TradeBuckets | null>(null)
  const [missingCounts, setMissingCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    const abortController = new AbortController()

    async function fetchData() {
      try {
        const response = await fetch(DATA_URL, { signal: abortController.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const json: TradesApiResponse = await response.json()
        console.log('JSON:', json)
        const missingCounter: Record<string, number> = {}
        const filtered = json.documents.filter((doc) => {
          if (isTradeDocument(doc)) return true
          const missing = getMissingTradeFields(doc)
          for (const key of missing) missingCounter[key] = (missingCounter[key] ?? 0) + 1
          return false
        })
        console.log('Filtered:', filtered)
        const newBuckets = splitTradesBySellValueUsd(filtered)
        setBuckets(newBuckets)
        setMissingCounts(missingCounter)
        console.log('Buckets:', newBuckets)
      } catch (error) {
        if ((error as { name?: string } | null)?.name !== 'AbortError') {
          console.error('Failed to fetch data:', error)
        }
      }
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


