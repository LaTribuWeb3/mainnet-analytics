import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatUSDCCompact, truncateToDecimals } from './utils/format'
import type { TradesApiResponse } from './types'
import { getMissingTradeFields, isTradeDocument } from './utils/guards'
import { splitTradesBySellValueUsd } from './utils/buckets'
import type { TradeBuckets } from './utils/buckets'
import { computeSellTokenPricesUSDC } from './utils/pryctoDelta'
import { toDay } from './utils/price'
import {
  avgDeltaWethPrice,
  avgDeltaVsExecutionPct,
  avgDeltaExecVsMarketPct,
  avgPryctoPremiumBps,
  avgRateDiffBps,
  avgProfitPair,
  avgExecPremiumBps,
  avgPryctoBidBuyOverWinnerBuy,
} from './utils/avg'

const DATA_URL = 'https://prod.mainnet.cowswap.la-tribu.xyz/db/USDC-WETH'
const CACHE_KEY = 'usdc-weth-trades-cache-v1'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const PRYCTO_ADDRESS = '0xa97851357e99082762c972f794b2a29e629511a7'

type CacheEntry = { data: TradesApiResponse; cachedAt: number }
function isCacheEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return 'data' in obj && 'cachedAt' in obj && typeof obj.cachedAt === 'number'
}

export default function App() {
  const [buckets, setBuckets] = useState<TradeBuckets | null>(null)
  const [pryctoApiBuckets, setPryctoApiBuckets] = useState<TradeBuckets | null>(null)
  const [missingCounts, setMissingCounts] = useState<Record<string, number>>({})
  const [rawResponse, setRawResponse] = useState<TradesApiResponse | null>(null)
  const [timeSpan, setTimeSpan] = useState<'yesterday' | 'last7' | 'last30'>('yesterday')
  const showMissing = false
  // Non-winning Prycto bidder dataset
  const [pryctoNonWinBuckets, setPryctoNonWinBuckets] = useState<TradeBuckets | null>(null)
  // Prycto win-rate time series (per day)
  const [pryctoWinSeries, setPryctoWinSeries] = useState<{ day: string; wins: number; total: number; rate: number }[] | null>(null)
  // Hover state for win-rate chart
  const [winHover, setWinHover] = useState<{ index: number; x: number; y: number } | null>(null)
  // Prycto daily won volume (USD) time series
  const [pryctoWinVolSeries, setPryctoWinVolSeries] = useState<{ day: string; volume: number }[] | null>(null)
  const [winVolHover, setWinVolHover] = useState<{ index: number; x: number; y: number } | null>(null)
  // Removed avgMarketWethPrice and avgPryctoWethPrice since columns were hidden
  console.log('pryctoApiBuckets', pryctoApiBuckets)

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
      // Build Prycto-specific dataset: validated docs containing any bid with Prycto solver address
      const pryctoDocs = valid.filter((doc) =>
        Array.isArray(doc.competitionData?.bidData) &&
        (doc.competitionData?.bidData || []).some(
          (bid) => (bid?.solverAddress || '').toLowerCase() === PRYCTO_ADDRESS
        )
      )
      // Non-winning Prycto documents: Prycto bid exists, winner exists, and winner is not Prycto
      const pryctoNonWinDocs = pryctoDocs.filter((doc) => {
        const bids = doc.competitionData?.bidData || []
        const winner = bids.find((b) => b?.winner === true)
        if (!winner) return false
        return (winner.solverAddress || '').toLowerCase() !== PRYCTO_ADDRESS
      })
      const newPryctoNonWinBuckets = splitTradesBySellValueUsd(pryctoNonWinDocs)
      setPryctoNonWinBuckets(newPryctoNonWinBuckets)
      const pryctoWithGaps = pryctoDocs
        .map((doc) => {
          const prices = computeSellTokenPricesUSDC(doc)
          const market = prices.market
          const prycto = prices.prycto
          const delta = Number.isFinite(market) && Number.isFinite(prycto)
            ? (prycto as number) - (market as number)
            : null
          const absGap = delta !== null ? Math.abs(delta) : null
          return { doc, prices, delta, absGap }
        })
        .filter((x) => x.absGap !== null) as { doc: typeof pryctoDocs[number]; prices: { market: number; prycto: number }; delta: number; absGap: number }[]

      const topAbove = pryctoWithGaps
        .filter((x) => x.delta > 0)
        .sort((a, b) => b.delta - a.delta)
        .slice(0, 10)

      const topBelow = pryctoWithGaps
        .filter((x) => x.delta < 0)
        .sort((a, b) => a.delta - b.delta)
        .slice(0, 10)

      if (topAbove.length > 0) {
        console.log('Top 10 Prycto ABOVE market (USDC per sell token):')
        console.table(
          topAbove.map(({ doc, prices, delta, absGap }) => ({
            txHash: doc.txHash,
            orderUid: doc.orderUid,
            sellToken: doc.sellToken,
            buyToken: doc.buyToken,
            marketUSDCPerSell: prices.market,
            pryctoUSDCPerSell: prices.prycto,
            delta,
            absGap,
          }))
        )
      }

      if (topBelow.length > 0) {
        console.log('Top 10 Prycto BELOW market (USDC per sell token):')
        console.table(
          topBelow.map(({ doc, prices, delta, absGap }) => ({
            txHash: doc.txHash,
            orderUid: doc.orderUid,
            sellToken: doc.sellToken,
            buyToken: doc.buyToken,
            marketUSDCPerSell: prices.market,
            pryctoUSDCPerSell: prices.prycto,
            delta,
            absGap,
          }))
        )
      }

      // Percentage of Prycto prices more than 1% off from market
      const eligible = pryctoWithGaps.filter((x) => Number.isFinite(x.prices.market) && (x.prices.market as number) !== 0)
      const offCount = eligible.reduce((acc, x) => {
        const market = x.prices.market as number
        const pct = Math.abs(x.delta / market)
        return acc + (pct > 0.01 ? 1 : 0)
      }, 0)
      const totalCount = eligible.length
      if (totalCount > 0) {
        const pctStr = ((offCount / totalCount) * 100).toFixed(2)
        console.log(`Prycto prices > 1% off from market: ${pctStr}% (${offCount} of ${totalCount})`)
      }
      // Build Prycto win-rate by day over the last 20 days (independent of selected timespan)
      const last20StartSec = endSec - 20 * day
      const dayToCounts: Record<string, { wins: number; total: number }> = {}
      for (const doc of json.documents) {
        const tsRaw = (doc as unknown as { blockTimestamp?: number | string | null }).blockTimestamp
        const ts = typeof tsRaw === 'string' ? Number(tsRaw) : tsRaw
        if (!Number.isFinite(ts)) continue
        if ((ts as number) < last20StartSec || (ts as number) >= endSec) continue
        const bids = (doc as { competitionData?: { bidData?: { solverAddress?: string; winner?: boolean }[] } }).competitionData?.bidData || []
        const pryctoParticipated = bids.some((b) => (b?.solverAddress || '').toLowerCase() === PRYCTO_ADDRESS)
        if (!pryctoParticipated) continue
        const winner = bids.find((b) => b?.winner === true)
        const isWin = !!winner && (winner?.solverAddress || '').toLowerCase() === PRYCTO_ADDRESS
        const dayKey = toDay(ts as number)
        if (!dayToCounts[dayKey]) dayToCounts[dayKey] = { wins: 0, total: 0 }
        dayToCounts[dayKey].total += 1
        if (isWin) dayToCounts[dayKey].wins += 1
      }
      const series = Object.entries(dayToCounts)
        .map(([day, { wins, total }]) => ({ day, wins, total, rate: total > 0 ? wins / total : 0 }))
        .sort((a, b) => (a.day < b.day ? -1 : 1))
      setPryctoWinSeries(series)

      // Build Prycto daily won volume (USD) over last 20 days (winner must be Prycto)
      const dayToVol: Record<string, number> = {}
      for (const doc of json.documents) {
        const tsRaw = (doc as unknown as { blockTimestamp?: number | string | null }).blockTimestamp
        const ts = typeof tsRaw === 'string' ? Number(tsRaw) : tsRaw
        if (!Number.isFinite(ts)) continue
        if ((ts as number) < last20StartSec || (ts as number) >= endSec) continue
        const bids = (doc as { competitionData?: { bidData?: { solverAddress?: string; winner?: boolean }[] } }).competitionData?.bidData || []
        const winner = bids.find((b) => b?.winner === true)
        const isWin = !!winner && (winner?.solverAddress || '').toLowerCase() === PRYCTO_ADDRESS
        if (!isWin) continue
        const volRaw = (doc as { orderSellValueUsd?: number | string }).orderSellValueUsd
        const vol = typeof volRaw === 'string' ? Number(volRaw) : volRaw
        if (!Number.isFinite(vol)) continue
        const dayKey = toDay(ts as number)
        dayToVol[dayKey] = (dayToVol[dayKey] ?? 0) + (vol as number)
      }
      const volSeries = Object.entries(dayToVol)
        .map(([day, volume]) => ({ day, volume }))
        .sort((a, b) => (a.day < b.day ? -1 : 1))
      setPryctoWinVolSeries(volSeries)
      // const newPryctoBuckets = splitTradesBySellValueUsd(pryctoDocs)
      // setPryctoBuckets(newPryctoBuckets)
      // Prycto API docs: only those with a non-null/numeric pryctoApiPrice
      const pryctoApiDocs = valid.filter((doc) => Number.isFinite((doc as { pryctoApiPrice?: number }).pryctoApiPrice))
      const newPryctoApiBuckets = splitTradesBySellValueUsd(pryctoApiDocs)
      setPryctoApiBuckets(newPryctoApiBuckets)
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

  const pryctoNonWinVolumes = useMemo(() => {
    if (!pryctoNonWinBuckets) return null
    const sum = (arr: { orderSellValueUsd: number | string }[]) =>
      arr.reduce((acc, t) => {
        const v = typeof t.orderSellValueUsd === 'string' ? Number(t.orderSellValueUsd) : t.orderSellValueUsd
        return Number.isFinite(v) ? acc + (v as number) : acc
      }, 0)
    return {
      b0_1k: sum(pryctoNonWinBuckets.b0_1k),
      b1k_5k: sum(pryctoNonWinBuckets.b1k_5k),
      b5k_20k: sum(pryctoNonWinBuckets.b5k_20k),
      b20k_50k: sum(pryctoNonWinBuckets.b20k_50k),
      b50k_100k: sum(pryctoNonWinBuckets.b50k_100k),
      b100k_500k: sum(pryctoNonWinBuckets.b100k_500k),
      b500k_5m: sum(pryctoNonWinBuckets.b500k_5m),
      b5m_plus: sum(pryctoNonWinBuckets.b5m_plus),
    }
  }, [pryctoNonWinBuckets])

  const premiums = useMemo(() => {
    if (!buckets) return null
    return {
      b0_1k: avgRateDiffBps(buckets.b0_1k),
      b1k_5k: avgRateDiffBps(buckets.b1k_5k),
      b5k_20k: avgRateDiffBps(buckets.b5k_20k),
      b20k_50k: avgRateDiffBps(buckets.b20k_50k),
      b50k_100k: avgRateDiffBps(buckets.b50k_100k),
      b100k_500k: avgRateDiffBps(buckets.b100k_500k),
      b500k_5m: avgRateDiffBps(buckets.b500k_5m),
      b5m_plus: avgRateDiffBps(buckets.b5m_plus),
    }
  }, [buckets])

  const profits = useMemo(() => {
    if (!buckets) return null
    return {
      b0_1k: avgProfitPair(buckets.b0_1k),
      b1k_5k: avgProfitPair(buckets.b1k_5k),
      b5k_20k: avgProfitPair(buckets.b5k_20k),
      b20k_50k: avgProfitPair(buckets.b20k_50k),
      b50k_100k: avgProfitPair(buckets.b50k_100k),
      b100k_500k: avgProfitPair(buckets.b100k_500k),
      b500k_5m: avgProfitPair(buckets.b500k_5m),
      b5m_plus: avgProfitPair(buckets.b5m_plus),
    }
  }, [buckets])

  const pryctoNonWinProfits = useMemo(() => {
    if (!pryctoNonWinBuckets) return null
    return {
      b0_1k: avgProfitPair(pryctoNonWinBuckets.b0_1k),
      b1k_5k: avgProfitPair(pryctoNonWinBuckets.b1k_5k),
      b5k_20k: avgProfitPair(pryctoNonWinBuckets.b5k_20k),
      b20k_50k: avgProfitPair(pryctoNonWinBuckets.b20k_50k),
      b50k_100k: avgProfitPair(pryctoNonWinBuckets.b50k_100k),
      b100k_500k: avgProfitPair(pryctoNonWinBuckets.b100k_500k),
      b500k_5m: avgProfitPair(pryctoNonWinBuckets.b500k_5m),
      b5m_plus: avgProfitPair(pryctoNonWinBuckets.b5m_plus),
    }
  }, [pryctoNonWinBuckets])

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

  const pryctoNonWinTotals = useMemo(() => {
    if (!pryctoNonWinBuckets) return null
    const totalOrders =
      pryctoNonWinBuckets.b0_1k.length +
      pryctoNonWinBuckets.b1k_5k.length +
      pryctoNonWinBuckets.b5k_20k.length +
      pryctoNonWinBuckets.b20k_50k.length +
      pryctoNonWinBuckets.b50k_100k.length +
      pryctoNonWinBuckets.b100k_500k.length +
      pryctoNonWinBuckets.b500k_5m.length +
      pryctoNonWinBuckets.b5m_plus.length
    const totalVolume = pryctoNonWinVolumes
      ? pryctoNonWinVolumes.b0_1k +
        pryctoNonWinVolumes.b1k_5k +
        pryctoNonWinVolumes.b5k_20k +
        pryctoNonWinVolumes.b20k_50k +
        pryctoNonWinVolumes.b50k_100k +
        pryctoNonWinVolumes.b100k_500k +
        pryctoNonWinVolumes.b500k_5m +
        pryctoNonWinVolumes.b5m_plus
      : 0
    return { totalOrders, totalVolume }
  }, [pryctoNonWinBuckets, pryctoNonWinVolumes])

  const pryctoApiVolumes = useMemo(() => {
    if (!pryctoApiBuckets) return null
    const sum = (arr: { orderSellValueUsd: number | string }[]) =>
      arr.reduce((acc, t) => {
        const v = typeof t.orderSellValueUsd === 'string' ? Number(t.orderSellValueUsd) : t.orderSellValueUsd
        return Number.isFinite(v) ? acc + (v as number) : acc
      }, 0)
    return {
      b0_1k: sum(pryctoApiBuckets.b0_1k),
      b1k_5k: sum(pryctoApiBuckets.b1k_5k),
      b5k_20k: sum(pryctoApiBuckets.b5k_20k),
      b20k_50k: sum(pryctoApiBuckets.b20k_50k),
      b50k_100k: sum(pryctoApiBuckets.b50k_100k),
      b100k_500k: sum(pryctoApiBuckets.b100k_500k),
      b500k_5m: sum(pryctoApiBuckets.b500k_5m),
      b5m_plus: sum(pryctoApiBuckets.b5m_plus),
    }
  }, [pryctoApiBuckets])

  

  const pryctoApiProfits = useMemo(() => {
    if (!pryctoApiBuckets) return null
    return {
      b0_1k: avgProfitPair(pryctoApiBuckets.b0_1k),
      b1k_5k: avgProfitPair(pryctoApiBuckets.b1k_5k),
      b5k_20k: avgProfitPair(pryctoApiBuckets.b5k_20k),
      b20k_50k: avgProfitPair(pryctoApiBuckets.b20k_50k),
      b50k_100k: avgProfitPair(pryctoApiBuckets.b50k_100k),
      b100k_500k: avgProfitPair(pryctoApiBuckets.b100k_500k),
      b500k_5m: avgProfitPair(pryctoApiBuckets.b500k_5m),
      b5m_plus: avgProfitPair(pryctoApiBuckets.b5m_plus),
    }
  }, [pryctoApiBuckets])

  const pryctoApiTotals = useMemo(() => {
    if (!pryctoApiBuckets) return null
    const totalOrders =
      pryctoApiBuckets.b0_1k.length +
      pryctoApiBuckets.b1k_5k.length +
      pryctoApiBuckets.b5k_20k.length +
      pryctoApiBuckets.b20k_50k.length +
      pryctoApiBuckets.b50k_100k.length +
      pryctoApiBuckets.b100k_500k.length +
      pryctoApiBuckets.b500k_5m.length +
      pryctoApiBuckets.b5m_plus.length
    const totalVolume = pryctoApiVolumes
      ? pryctoApiVolumes.b0_1k +
        pryctoApiVolumes.b1k_5k +
        pryctoApiVolumes.b5k_20k +
        pryctoApiVolumes.b20k_50k +
        pryctoApiVolumes.b50k_100k +
        pryctoApiVolumes.b100k_500k +
        pryctoApiVolumes.b500k_5m +
        pryctoApiVolumes.b5m_plus
      : 0
    return { totalOrders, totalVolume }
  }, [pryctoApiBuckets, pryctoApiVolumes])

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

      <h2 style={{ marginTop: '1rem', marginBottom: '0.5rem', fontWeight: 600 }}>Overall analytics</h2>
      <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Bucket</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Orders</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Volume USD</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Share of total volume</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Avg profit excl. fees (USD)</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Avg profit incl. fees (USD)</th>
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
          </tr>
        </thead>
        <tbody>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">0 - 1k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b0_1k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b0_1k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b0_1k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b0_1k.ex !== null ? `$${formatUSDCCompact(profits.b0_1k.ex as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b0_1k.inc !== null ? `$${formatUSDCCompact(profits.b0_1k.inc as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b0_1k !== null ? (premiums.b0_1k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">1k - 5k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b1k_5k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b1k_5k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b1k_5k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b1k_5k.ex !== null ? `$${formatUSDCCompact(profits.b1k_5k.ex as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b1k_5k.inc !== null ? `$${formatUSDCCompact(profits.b1k_5k.inc as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b1k_5k !== null ? (premiums.b1k_5k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5k - 20k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b5k_20k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b5k_20k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b5k_20k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b5k_20k.ex !== null ? `$${formatUSDCCompact(profits.b5k_20k.ex as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b5k_20k.inc !== null ? `$${formatUSDCCompact(profits.b5k_20k.inc as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b5k_20k !== null ? (premiums.b5k_20k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">20k - 50k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b20k_50k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b20k_50k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b20k_50k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b20k_50k.ex !== null ? `$${formatUSDCCompact(profits.b20k_50k.ex as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b20k_50k.inc !== null ? `$${formatUSDCCompact(profits.b20k_50k.inc as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b20k_50k !== null ? (premiums.b20k_50k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">50k - 100k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b50k_100k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b50k_100k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b50k_100k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b50k_100k.ex !== null ? `$${formatUSDCCompact(profits.b50k_100k.ex as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b50k_100k.inc !== null ? `$${formatUSDCCompact(profits.b50k_100k.inc as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b50k_100k !== null ? (premiums.b50k_100k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">100k - 500k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b100k_500k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b100k_500k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b100k_500k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b100k_500k.ex !== null ? `$${formatUSDCCompact(profits.b100k_500k.ex as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b100k_500k.inc !== null ? `$${formatUSDCCompact(profits.b100k_500k.inc as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b100k_500k !== null ? (premiums.b100k_500k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">500k - 5m</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b500k_5m.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b500k_5m)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b500k_5m / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b500k_5m.ex !== null ? `$${formatUSDCCompact(profits.b500k_5m.ex as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b500k_5m.inc !== null ? `$${formatUSDCCompact(profits.b500k_5m.inc as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b500k_5m !== null ? (premiums.b500k_5m as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5m+</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b5m_plus.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b5m_plus)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b5m_plus / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b5m_plus.ex !== null ? `$${formatUSDCCompact(profits.b5m_plus.ex as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{profits && profits.b5m_plus.inc !== null ? `$${formatUSDCCompact(profits.b5m_plus.inc as number)}` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b5m_plus !== null ? (premiums.b5m_plus as number).toFixed(1) : '-'}</td>
          </tr>
        </tbody>
      </table>

    
      {/* <h2 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: 600 }}>Prycto analytics</h2>
      <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Bucket</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Orders</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50" title={'Average execution premium (bps) from rateDiffBps for Prycto docs'}>Execution premium avg (bps)</th>
          </tr>
        </thead>
        <tbody>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">0 - 1k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoBuckets ? pryctoBuckets.b0_1k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b0_1k !== null ? (pryctoApiPremiums.b0_1k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">1k - 5k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoBuckets ? pryctoBuckets.b1k_5k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b1k_5k !== null ? (pryctoApiPremiums.b1k_5k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5k - 20k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoBuckets ? pryctoBuckets.b5k_20k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b5k_20k !== null ? (pryctoApiPremiums.b5k_20k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">20k - 50k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoBuckets ? pryctoBuckets.b20k_50k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b20k_50k !== null ? (pryctoApiPremiums.b20k_50k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">50k - 100k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoBuckets ? pryctoBuckets.b50k_100k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b50k_100k !== null ? (pryctoApiPremiums.b50k_100k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">100k - 500k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoBuckets ? pryctoBuckets.b100k_500k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b100k_500k !== null ? (pryctoApiPremiums.b100k_500k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">500k - 5m</td>
            <td className="px-4 py-2 border-b text-right">{pryctoBuckets ? pryctoBuckets.b500k_5m.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b500k_5m !== null ? (pryctoApiPremiums.b500k_5m as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5m+</td>
            <td className="px-4 py-2 border-b text-right">{pryctoBuckets ? pryctoBuckets.b5m_plus.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b5m_plus !== null ? (pryctoApiPremiums.b5m_plus as number).toFixed(1) : '-'}</td>
          </tr>
        </tbody>
      </table> */}

      {pryctoWinSeries && pryctoWinSeries.length > 0 && (
        <>
          <h2 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: 600 }}>Prycto win rate over time</h2>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem' }}>
            {(() => {
              const w = 1000
              const h = 320
              const pad = 32
              const series = pryctoWinSeries
              const n = series.length
              const xFor = (i: number) => pad + (n === 1 ? 0 : (i * (w - 2 * pad)) / (n - 1))
              const yMax = 0.6
              const yFor = (rate: number) => {
                const clamped = Math.max(0, Math.min(yMax, rate))
                const norm = clamped / yMax
                return pad + (1 - norm) * (h - 2 * pad)
              }
              // 7-day moving average using aggregated wins/total in window
              const maWindow = 7
              const maRates = series.map((_, i) => {
                const start = Math.max(0, i - (maWindow - 1))
                let wins = 0
                let total = 0
                for (let j = start; j <= i; j++) {
                  wins += series[j].wins
                  total += series[j].total
                }
                return total > 0 ? wins / total : 0
              })
              const pointsRaw = series.map((s, i) => `${xFor(i)},${yFor(s.rate)}`).join(' ')
              const pointsMA = maRates.map((r, i) => `${xFor(i)},${yFor(r)}`).join(' ')
              const legendW = 160
              const legendH = 30
              const legendX = (w - legendW) / 2
              const legendY = pad
              return (
                <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`}>
                  {/* Axes */}
                  <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#e5e7eb" />
                  <line x1={pad} y1={pad} x2={pad} y2={h - pad} stroke="#e5e7eb" />
                  {/* Y ticks */}
                  {[0, 0.3, 0.6].map((t) => (
                    <g key={t}>
                      <line x1={pad - 4} y1={yFor(t)} x2={w - pad} y2={yFor(t)} stroke="#f3f4f6" />
                      <text x={8} y={yFor(t) + 4} fontSize={12} fill="#6b7280">{`${Math.round(t * 100)}%`}</text>
                    </g>
                  ))}
                  {/* X grid and labels (sparse) */}
                  {(() => {
                    const tickCount = Math.min(6, n)
                    const idxs = new Set(Array.from({ length: tickCount }, (_, k) => Math.round((k * (n - 1)) / (tickCount - 1 || 1))))
                    return (
                      <g>
                        {series.map((s, i) => (
                          idxs.has(i) ? (
                            <g key={`x-${s.day}`}>
                              <line x1={xFor(i)} y1={pad} x2={xFor(i)} y2={h - pad} stroke="#f3f4f6" />
                              <text x={xFor(i)} y={h - pad + 22} fontSize={10} fill="#6b7280" textAnchor="end" transform={`rotate(-45 ${xFor(i)},${h - pad + 22})`}>
                                {s.day}
                              </text>
                            </g>
                          ) : null
                        ))}
                      </g>
                    )
                  })()}
                  {/* Raw rate line (light) */}
                  <polyline fill="none" stroke="#93c5fd" strokeWidth={1} points={pointsRaw} />
                  {/* Moving average line (7-day) */}
                  <polyline fill="none" stroke="#2563eb" strokeWidth={2} points={pointsMA} />
                  {/* MA dots */}
                  {maRates.map((r, i) => (
                    <circle key={`ma-${series[i].day}`} cx={xFor(i)} cy={yFor(r)} r={3} fill="#2563eb" />
                  ))}
                  {/* Hover targets for daily raw points */}
                  {series.map((s, i) => (
                    <circle
                      key={`raw-hit-${s.day}`}
                      cx={xFor(i)}
                      cy={yFor(s.rate)}
                      r={8}
                      fill="#000"
                      opacity={0.001}
                      onMouseEnter={(e) => setWinHover({ index: i, x: (e.nativeEvent as unknown as MouseEvent).offsetX ?? xFor(i), y: (e.nativeEvent as unknown as MouseEvent).offsetY ?? yFor(s.rate) })}
                      onMouseMove={(e) => setWinHover({ index: i, x: (e.nativeEvent as unknown as MouseEvent).offsetX ?? xFor(i), y: (e.nativeEvent as unknown as MouseEvent).offsetY ?? yFor(s.rate) })}
                      onMouseLeave={() => setWinHover(null)}
                      style={{ cursor: 'pointer' }}
                    />
                  ))}
                  {/* Hover targets for MA points */}
                  {maRates.map((r, i) => (
                    <circle
                      key={`ma-hit-${series[i].day}`}
                      cx={xFor(i)}
                      cy={yFor(r)}
                      r={8}
                      fill="#000"
                      opacity={0.001}
                      onMouseEnter={(e) => setWinHover({ index: i, x: (e.nativeEvent as unknown as MouseEvent).offsetX ?? xFor(i), y: (e.nativeEvent as unknown as MouseEvent).offsetY ?? yFor(r) })}
                      onMouseMove={(e) => setWinHover({ index: i, x: (e.nativeEvent as unknown as MouseEvent).offsetX ?? xFor(i), y: (e.nativeEvent as unknown as MouseEvent).offsetY ?? yFor(r) })}
                      onMouseLeave={() => setWinHover(null)}
                      style={{ cursor: 'pointer' }}
                    />
                  ))}
                  {/* Tooltip */}
                  {winHover && (() => {
                    const i = winHover.index
                    const d = series[i]
                    const rRaw = d.rate
                    const rMA = maRates[i]
                    const label = `${d.day}\nDaily: ${(rRaw * 100).toFixed(1)}%  •  7d MA: ${(rMA * 100).toFixed(1)}%`
                    const boxW = 200
                    const lines = label.split('\n')
                    const lineH = 16
                    const boxH = lineH * lines.length + 10
                    const px = Math.min(Math.max(pad, xFor(i) + 10), w - pad - boxW)
                    const py = Math.min(Math.max(pad, yFor(rRaw) - boxH - 10), h - pad - boxH)
                    return (
                      <g>
                        <rect x={px} y={py} width={boxW} height={boxH} rx={6} ry={6} fill="#111827" opacity={0.9} />
                        {lines.map((ln, idx) => (
                          <text key={idx} x={px + 8} y={py + 8 + lineH * (idx + 1) - 6} fontSize={12} fill="#f9fafb">{ln}</text>
                        ))}
                      </g>
                    )
                  })()}
                  {/* Legend (centered) */}
                  <rect x={legendX} y={legendY} width={legendW} height={legendH} rx={6} ry={6} fill="#ffffff" stroke="#e5e7eb" />
                  <line x1={legendX + 10} y1={legendY + 11} x2={legendX + 30} y2={legendY + 11} stroke="#93c5fd" strokeWidth={2} />
                  <text x={legendX + 35} y={legendY + 14} fontSize={12} fill="#6b7280">Daily rate</text>
                  <line x1={legendX + 10} y1={legendY + 23} x2={legendX + 30} y2={legendY + 23} stroke="#2563eb" strokeWidth={2} />
                  <text x={legendX + 35} y={legendY + 26} fontSize={12} fill="#6b7280">7-day MA</text>
                </svg>
              )
            })()}
            <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>
              Win rate = wins / participations where Prycto bid is present; per UTC day. Y-axis capped at 60%. Moving average aggregates wins and total over a 7-day window.
            </div>
          </div>
        </>
      )}

      {pryctoWinVolSeries && pryctoWinVolSeries.length > 0 && (
        <>
          <h2 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: 600 }}>Prycto won volume over time</h2>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem' }}>
            {(() => {
              const w = 1000
              const h = 320
              const pad = 32
              const series = pryctoWinVolSeries
              const n = series.length
              const xFor = (i: number) => pad + (n === 1 ? 0 : (i * (w - 2 * pad)) / (n - 1))
              const maxVol = Math.max(...series.map((s) => s.volume), 1)
              const yFor = (vol: number) => {
                const clamped = Math.max(0, Math.min(maxVol, vol))
                const norm = maxVol === 0 ? 0 : clamped / maxVol
                return pad + (1 - norm) * (h - 2 * pad)
              }
              // 7-day moving average for volume (simple mean)
              const maWindow = 7
              const maVol = series.map((_, i) => {
                const start = Math.max(0, i - (maWindow - 1))
                let sum = 0
                let cnt = 0
                for (let j = start; j <= i; j++) {
                  sum += series[j].volume
                  cnt += 1
                }
                return cnt > 0 ? sum / cnt : 0
              })
              const pointsRaw = series.map((s, i) => `${xFor(i)},${yFor(s.volume)}`).join(' ')
              const pointsMA = maVol.map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ')
              const legendW = 180
              const legendH = 30
              const legendX = (w - legendW) / 2
              const legendY = pad
              return (
                <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`}>
                  {/* Axes */}
                  <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="#e5e7eb" />
                  <line x1={pad} y1={pad} x2={pad} y2={h - pad} stroke="#e5e7eb" />
                  {/* Y ticks (auto based on max) */}
                  {[0, 0.25, 0.5, 0.75, 1].map((t) => (
                    <g key={t}>
                      <line x1={pad - 4} y1={yFor(maxVol * t)} x2={w - pad} y2={yFor(maxVol * t)} stroke="#f3f4f6" />
                      <text x={8} y={yFor(maxVol * t) + 4} fontSize={12} fill="#6b7280">{`$${formatUSDCCompact(maxVol * t)}`}</text>
                    </g>
                  ))}
                  {/* X grid and labels (sparse) */}
                  {(() => {
                    const tickCount = Math.min(6, n)
                    const idxs = new Set(Array.from({ length: tickCount }, (_, k) => Math.round((k * (n - 1)) / (tickCount - 1 || 1))))
                    return (
                      <g>
                        {series.map((s, i) => (
                          idxs.has(i) ? (
                            <g key={`xv-${s.day}`}>
                              <line x1={xFor(i)} y1={pad} x2={xFor(i)} y2={h - pad} stroke="#f3f4f6" />
                              <text x={xFor(i)} y={h - pad + 22} fontSize={10} fill="#6b7280" textAnchor="end" transform={`rotate(-45 ${xFor(i)},${h - pad + 22})`}>
                                {s.day}
                              </text>
                            </g>
                          ) : null
                        ))}
                      </g>
                    )
                  })()}
                  {/* Raw line (light) */}
                  <polyline fill="none" stroke="#93c5fd" strokeWidth={1} points={pointsRaw} />
                  {/* Moving average line (7-day) */}
                  <polyline fill="none" stroke="#2563eb" strokeWidth={2} points={pointsMA} />
                  {/* Hover targets */}
                  {series.map((s, i) => (
                    <circle
                      key={`vol-hit-${s.day}`}
                      cx={xFor(i)}
                      cy={yFor(s.volume)}
                      r={8}
                      fill="#000"
                      opacity={0.001}
                      onMouseEnter={(e) => setWinVolHover({ index: i, x: (e.nativeEvent as unknown as MouseEvent).offsetX ?? xFor(i), y: (e.nativeEvent as unknown as MouseEvent).offsetY ?? yFor(s.volume) })}
                      onMouseMove={(e) => setWinVolHover({ index: i, x: (e.nativeEvent as unknown as MouseEvent).offsetX ?? xFor(i), y: (e.nativeEvent as unknown as MouseEvent).offsetY ?? yFor(s.volume) })}
                      onMouseLeave={() => setWinVolHover(null)}
                      style={{ cursor: 'pointer' }}
                    />
                  ))}
                  {maVol.map((v, i) => (
                    <circle key={`vol-ma-${series[i].day}`} cx={xFor(i)} cy={yFor(v)} r={3} fill="#2563eb" />
                  ))}
                  {/* Tooltip */}
                  {winVolHover && (() => {
                    const i = winVolHover.index
                    const d = series[i]
                    const mv = maVol[i]
                    const label = `${d.day}\nVolume: $${formatUSDCCompact(d.volume)}  •  7d MA: $${formatUSDCCompact(mv)}`
                    const boxW = 220
                    const lines = label.split('\n')
                    const lineH = 16
                    const boxH = lineH * lines.length + 10
                    const px = Math.min(Math.max(pad, xFor(i) + 10), w - pad - boxW)
                    const py = Math.min(Math.max(pad, yFor(d.volume) - boxH - 10), h - pad - boxH)
                    return (
                      <g>
                        <rect x={px} y={py} width={boxW} height={boxH} rx={6} ry={6} fill="#111827" opacity={0.9} />
                        {lines.map((ln, idx) => (
                          <text key={idx} x={px + 8} y={py + 8 + lineH * (idx + 1) - 6} fontSize={12} fill="#f9fafb">{ln}</text>
                        ))}
                      </g>
                    )
                  })()}
                  {/* Legend (centered) */}
                  <rect x={legendX} y={legendY} width={legendW} height={legendH} rx={6} ry={6} fill="#ffffff" stroke="#e5e7eb" />
                  <line x1={legendX + 10} y1={legendY + 11} x2={legendX + 30} y2={legendY + 11} stroke="#93c5fd" strokeWidth={2} />
                  <text x={legendX + 35} y={legendY + 14} fontSize={12} fill="#6b7280">Daily volume</text>
                  <line x1={legendX + 10} y1={legendY + 23} x2={legendX + 30} y2={legendY + 23} stroke="#2563eb" strokeWidth={2} />
                  <text x={legendX + 35} y={legendY + 26} fontSize={12} fill="#6b7280">7-day MA</text>
                </svg>
              )
            })()}
            <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>
              Daily won volume: sum of `orderSellValueUsd` for orders where Prycto is the winner; per UTC day. 7-day MA is a simple average.
            </div>
          </div>
        </>
      )}
      <h2 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: 600 }}>Prycto Price API analytics</h2>
      <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Bucket</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Orders</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50" title={'Average of per-document delta percentages: (Prycto − Execution) / Execution × 100, direction-adjusted'}>Avg Delta Prycto vs Exec (%)</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50" title={'Average of per-document delta percentages: (Prycto − Market) / Market × 100, direction-adjusted'}>Avg Delta Prycto vs Market (%)</th>
            <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50" title={'Average of per-document delta percentages: (Execution − Market) / Market × 100, direction-adjusted'}>Avg Delta Exec vs Market (%)</th>
          </tr>
        </thead>
        <tbody>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">0 - 1k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b0_1k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(pryctoApiBuckets.b0_1k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(pryctoApiBuckets.b0_1k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(pryctoApiBuckets.b0_1k)?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">1k - 5k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b1k_5k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(pryctoApiBuckets.b1k_5k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(pryctoApiBuckets.b1k_5k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(pryctoApiBuckets.b1k_5k)?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5k - 20k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b5k_20k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(pryctoApiBuckets.b5k_20k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(pryctoApiBuckets.b5k_20k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(pryctoApiBuckets.b5k_20k)?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">20k - 50k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b20k_50k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(pryctoApiBuckets.b20k_50k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(pryctoApiBuckets.b20k_50k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(pryctoApiBuckets.b20k_50k)?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">50k - 100k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b50k_100k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(pryctoApiBuckets.b50k_100k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(pryctoApiBuckets.b50k_100k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(pryctoApiBuckets.b50k_100k)?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">100k - 500k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b100k_500k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(pryctoApiBuckets.b100k_500k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(pryctoApiBuckets.b100k_500k)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(pryctoApiBuckets.b100k_500k)?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">500k - 5m</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b500k_5m.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(pryctoApiBuckets.b500k_5m)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(pryctoApiBuckets.b500k_5m)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(pryctoApiBuckets.b500k_5m)?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5m+</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b5m_plus.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(pryctoApiBuckets.b5m_plus)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(pryctoApiBuckets.b5m_plus)?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(pryctoApiBuckets.b5m_plus)?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
        </tbody>
      </table>
      {pryctoApiBuckets && (
        <>
        <br />
          <h2 style={{ marginTop: '1rem', marginBottom: '0.5rem', fontWeight: 600, opacity: 0 }}>Prycto Price API overall analytics</h2>
          <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Bucket</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Orders</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Volume USD</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Share of total volume</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Avg profit excl. fees (USD)</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Avg profit incl. fees (USD)</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50" title={'Average Prycto premium (bps): (Prycto − Market) / Market × 10,000, direction-adjusted'}>Prycto premium average (bps)</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50" title={'Execution premium vs market (bps), direction-adjusted: (Execution − Market) / Market × 10,000'}>Execution premium average (bps)</th>
              </tr>
            </thead>
            <tbody>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">0 - 1k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b0_1k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b0_1k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b0_1k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b0_1k.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b0_1k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b0_1k.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b0_1k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b0_1k)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(pryctoApiBuckets.b0_1k)?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">1k - 5k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b1k_5k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b1k_5k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b1k_5k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b1k_5k.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b1k_5k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b1k_5k.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b1k_5k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b1k_5k)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(pryctoApiBuckets.b1k_5k)?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">5k - 20k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b5k_20k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b5k_20k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b5k_20k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b5k_20k.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b5k_20k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b5k_20k.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b5k_20k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b5k_20k)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(pryctoApiBuckets.b5k_20k)?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">20k - 50k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b20k_50k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b20k_50k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b20k_50k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b20k_50k.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b20k_50k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b20k_50k.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b20k_50k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b20k_50k)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(pryctoApiBuckets.b20k_50k)?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">50k - 100k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b50k_100k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b50k_100k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b50k_100k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b50k_100k.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b50k_100k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b50k_100k.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b50k_100k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b50k_100k)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(pryctoApiBuckets.b50k_100k)?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">100k - 500k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b100k_500k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b100k_500k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b100k_500k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b100k_500k.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b100k_500k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b100k_500k.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b100k_500k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b100k_500k)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(pryctoApiBuckets.b100k_500k)?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">500k - 5m</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b500k_5m.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b500k_5m)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b500k_5m / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b500k_5m.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b500k_5m.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b500k_5m.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b500k_5m.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b500k_5m)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(pryctoApiBuckets.b500k_5m)?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">5m+</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b5m_plus.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b5m_plus)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b5m_plus / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b5m_plus.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b5m_plus.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b5m_plus.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b5m_plus.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b5m_plus)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(pryctoApiBuckets.b5m_plus)?.toFixed(1) ?? '-').toString()}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      {pryctoNonWinBuckets && (
        <>
          <br />
          <h2 style={{ marginTop: '1rem', marginBottom: '0.5rem', fontWeight: 600 }}>Prycto bidder (non-winning) overall analytics</h2>
          <table className="min-w-full" style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th className="px-4 py-2 text-left text-sm font-semibold text-gray-700 border-b bg-gray-50">Bucket</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Orders</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Volume USD</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Share of total volume</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Avg profit excl. fees (USD)</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Avg profit incl. fees (USD)</th>
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50" title={'Average over docs of (Prycto bid buyAmount / Winner bid buyAmount), amounts normalized to token decimals'}>Prycto buyAmount / Winner buyAmount (avg)</th>
              </tr>
            </thead>
            <tbody>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">0 - 1k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b0_1k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b0_1k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b0_1k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b0_1k.ex !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b0_1k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b0_1k.inc !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b0_1k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b0_1k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">1k - 5k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b1k_5k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b1k_5k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b1k_5k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b1k_5k.ex !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b1k_5k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b1k_5k.inc !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b1k_5k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b1k_5k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">5k - 20k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b5k_20k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b5k_20k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b5k_20k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b5k_20k.ex !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b5k_20k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b5k_20k.inc !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b5k_20k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b5k_20k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">20k - 50k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b20k_50k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b20k_50k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b20k_50k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b20k_50k.ex !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b20k_50k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b20k_50k.inc !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b20k_50k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b20k_50k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">50k - 100k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b50k_100k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b50k_100k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b50k_100k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b50k_100k.ex !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b50k_100k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b50k_100k.inc !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b50k_100k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b50k_100k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">100k - 500k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b100k_500k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b100k_500k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b100k_500k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b100k_500k.ex !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b100k_500k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b100k_500k.inc !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b100k_500k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b100k_500k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">500k - 5m</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b500k_5m.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b500k_5m)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b500k_5m / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b500k_5m.ex !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b500k_5m.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b500k_5m.inc !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b500k_5m.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b500k_5m, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">5m+</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b5m_plus.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b5m_plus)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b5m_plus / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b5m_plus.ex !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b5m_plus.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinProfits && pryctoNonWinProfits.b5m_plus.inc !== null ? `$${formatUSDCCompact(pryctoNonWinProfits.b5m_plus.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b5m_plus, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
            </tbody>
          </table>
        </>
      )}

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


