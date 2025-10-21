import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatUSDCCompact } from './utils/format'
import type { TradesApiResponse } from './types'
import { getMissingTradeFields, isTradeDocument } from './utils/guards'
import { splitTradesBySellValueUsd } from './utils/buckets'
import type { TradeBuckets } from './utils/buckets'
import { computeSellTokenPricesUSDC } from './utils/pryctoDelta'
import { TOKENS, computePriceUSDCPerToken, higherPriceIsBetterUSDCPerToken } from './utils/price'

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
  const [pryctoBuckets, setPryctoBuckets] = useState<TradeBuckets | null>(null)
  const [pryctoApiBuckets, setPryctoApiBuckets] = useState<TradeBuckets | null>(null)
  const [missingCounts, setMissingCounts] = useState<Record<string, number>>({})
  const [rawResponse, setRawResponse] = useState<TradesApiResponse | null>(null)
  const [timeSpan, setTimeSpan] = useState<'yesterday' | 'last7' | 'last30'>('yesterday')
  const showMissing = false
  // Removed avgMarketWethPrice and avgPryctoWethPrice since columns were hidden

  function avgDeltaWethPrice(docs: { buyToken: string; sellToken: string; buyUsdcPrice: number; sellUsdcPrice: number; pryctoApiPrice?: number }[]): number | null {
    const WETH = TOKENS.WETH
    let sumPct = 0
    let count = 0
    for (const d of docs) {
      const isWethBuy = (d.buyToken || '').toLowerCase() === WETH
      const isWethSell = (d.sellToken || '').toLowerCase() === WETH
      if (!isWethBuy && !isWethSell) continue
      const market = isWethBuy ? d.buyUsdcPrice : d.sellUsdcPrice
      const prycto = (d as { pryctoApiPrice?: number }).pryctoApiPrice
      if (!Number.isFinite(market) || !Number.isFinite(prycto) || market === 0) continue
      const rawPct = (((prycto as number) - (market as number)) / (market as number)) * 100
      const dir = higherPriceIsBetterUSDCPerToken(d.sellToken, d.buyToken)
      if (dir === null) continue
      const adjustedPct = rawPct * (dir ? 1 : -1)
      sumPct += adjustedPct
      count += 1
    }
    if (count === 0) return null
    return sumPct / count
  }

  function avgDeltaVsExecutionPct(docs: { buyToken: string; sellToken: string; sellAmount: string; buyAmount: string; pryctoApiPrice?: number }[]): number | null {
    let sumPct = 0
    let count = 0
    for (const d of docs) {
      const exec = computePriceUSDCPerToken(d.sellToken, d.buyToken, d.sellAmount, d.buyAmount)
      const prycto = (d as { pryctoApiPrice?: number }).pryctoApiPrice
      if (!Number.isFinite(exec) || !Number.isFinite(prycto) || (exec as number) === 0) continue
      const rawPct = (((prycto as number) - (exec as number)) / (exec as number)) * 100
      const dir = higherPriceIsBetterUSDCPerToken(d.sellToken, d.buyToken)
      if (dir === null) continue
      const adjustedPct = rawPct * (dir ? 1 : -1)
      sumPct += adjustedPct
      count += 1
    }
    if (count === 0) return null
    return sumPct / count
  }

  function avgDeltaWinnerVsMarketPct(docs: { buyToken: string; sellToken: string; buyUsdcPrice: number; sellUsdcPrice: number; competitionData?: { bidData?: { winner?: boolean; sellAmount: string; buyAmount: string }[] } }[]): number | null {
    let sumPct = 0
    let count = 0
    for (const d of docs) {
      const bids = d.competitionData?.bidData || []
      const winner = bids.find((b) => b?.winner === true)
      if (!winner) continue
      const bidPrice = computePriceUSDCPerToken(d.sellToken, d.buyToken, winner.sellAmount, winner.buyAmount)
      if (!Number.isFinite(bidPrice) || (bidPrice as number) === 0) continue
      // Market USDC per non-USDC token
      const isSellUSDC = (d.sellToken || '').toLowerCase() === TOKENS.USDC
      const isBuyUSDC = (d.buyToken || '').toLowerCase() === TOKENS.USDC
      let market: number | null = null
      if (isSellUSDC) market = d.buyUsdcPrice
      else if (isBuyUSDC) market = d.sellUsdcPrice
      if (!Number.isFinite(market) || (market as number) === 0) continue
      const rawPct = (((bidPrice as number) - (market as number)) / (market as number)) * 100
      const dir = higherPriceIsBetterUSDCPerToken(d.sellToken, d.buyToken)
      if (dir === null) continue
      const adjustedPct = rawPct * (dir ? 1 : -1)
      sumPct += adjustedPct
      count += 1
    }
    if (count === 0) return null
    return sumPct / count
  }

  function avgDeltaExecVsMarketPct(docs: { buyToken: string; sellToken: string; sellAmount: string; buyAmount: string; buyUsdcPrice: number; sellUsdcPrice: number }[]): number | null {
    let sumPct = 0
    let count = 0
    for (const d of docs) {
      const exec = computePriceUSDCPerToken(d.sellToken, d.buyToken, d.sellAmount, d.buyAmount)
      if (!Number.isFinite(exec) || (exec as number) === 0) continue
      const isSellUSDC = (d.sellToken || '').toLowerCase() === TOKENS.USDC
      const isBuyUSDC = (d.buyToken || '').toLowerCase() === TOKENS.USDC
      let market: number | null = null
      if (isSellUSDC) market = d.buyUsdcPrice
      else if (isBuyUSDC) market = d.sellUsdcPrice
      if (!Number.isFinite(market) || (market as number) === 0) continue
      const rawPct = (((exec as number) - (market as number)) / (market as number)) * 100
      const dir = higherPriceIsBetterUSDCPerToken(d.sellToken, d.buyToken)
      if (dir === null) continue
      const adjustedPct = rawPct * (dir ? 1 : -1)
      sumPct += adjustedPct
      count += 1
    }
    if (count === 0) return null
    return sumPct / count
  }

  function avgPryctoPremiumBps(
    docs: { buyToken: string; sellToken: string; buyUsdcPrice: number; sellUsdcPrice: number; pryctoApiPrice?: number }[]
  ): number | null {
    const WETH = TOKENS.WETH
    let sumBps = 0
    let count = 0
    for (const d of docs) {
      const isWethBuy = (d.buyToken || '').toLowerCase() === WETH
      const isWethSell = (d.sellToken || '').toLowerCase() === WETH
      if (!isWethBuy && !isWethSell) continue
      const market = isWethBuy ? d.buyUsdcPrice : d.sellUsdcPrice
      const prycto = (d as { pryctoApiPrice?: number }).pryctoApiPrice
      const dir = higherPriceIsBetterUSDCPerToken(d.sellToken, d.buyToken)
      if (!Number.isFinite(market) || !Number.isFinite(prycto) || market === 0 || dir === null) continue
      const rawPct = (((prycto as number) - (market as number)) / (market as number)) * 100
      const adjustedPct = rawPct * (dir ? 1 : -1)
      sumBps += adjustedPct * 100 // 1% = 100 bps
      count += 1
    }
    if (count === 0) return null
    return sumBps / count
  }

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
      const newPryctoBuckets = splitTradesBySellValueUsd(pryctoDocs)
      setPryctoBuckets(newPryctoBuckets)
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

  const profits = useMemo(() => {
    if (!buckets) return null
    const avgPair = (arr: { usdPnLExcludingFee: number | string; feeInUSD: number | string }[]) => {
      let sumEx = 0
      let sumInc = 0
      let count = 0
      for (const t of arr) {
        const pnlEx = typeof t.usdPnLExcludingFee === 'string' ? Number(t.usdPnLExcludingFee) : t.usdPnLExcludingFee
        const fee = typeof t.feeInUSD === 'string' ? Number(t.feeInUSD) : t.feeInUSD
        if (Number.isFinite(pnlEx) && Number.isFinite(fee)) {
          sumEx += pnlEx as number
          sumInc += (pnlEx as number) - (fee as number)
          count += 1
        }
      }
      return count > 0 ? { ex: sumEx / count, inc: sumInc / count } : { ex: null, inc: null }
    }
    return {
      b0_1k: avgPair(buckets.b0_1k),
      b1k_5k: avgPair(buckets.b1k_5k),
      b5k_20k: avgPair(buckets.b5k_20k),
      b20k_50k: avgPair(buckets.b20k_50k),
      b50k_100k: avgPair(buckets.b50k_100k),
      b100k_500k: avgPair(buckets.b100k_500k),
      b500k_5m: avgPair(buckets.b500k_5m),
      b5m_plus: avgPair(buckets.b5m_plus),
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

  const pryctoApiPremiums = useMemo(() => {
    if (!pryctoApiBuckets) return null
    const avg = (arr: { rateDiffBps: number | string; sellToken: string; buyToken: string }[]) => {
      let sum = 0
      let count = 0
      for (const t of arr) {
        const v = typeof t.rateDiffBps === 'string' ? Number(t.rateDiffBps) : t.rateDiffBps
        const dir = higherPriceIsBetterUSDCPerToken(t.sellToken, t.buyToken)
        if (Number.isFinite(v) && dir !== null) {
          const adjusted = (v as number) * (dir ? 1 : -1)
          sum += adjusted
          count += 1
        }
      }
      return count > 0 ? sum / count : null
    }
    return {
      b0_1k: avg(pryctoApiBuckets.b0_1k),
      b1k_5k: avg(pryctoApiBuckets.b1k_5k),
      b5k_20k: avg(pryctoApiBuckets.b5k_20k),
      b20k_50k: avg(pryctoApiBuckets.b20k_50k),
      b50k_100k: avg(pryctoApiBuckets.b50k_100k),
      b100k_500k: avg(pryctoApiBuckets.b100k_500k),
      b500k_5m: avg(pryctoApiBuckets.b500k_5m),
      b5m_plus: avg(pryctoApiBuckets.b5m_plus),
    }
  }, [pryctoApiBuckets])

  const pryctoApiProfits = useMemo(() => {
    if (!pryctoApiBuckets) return null
    const avgPair = (arr: { usdPnLExcludingFee: number | string; feeInUSD: number | string }[]) => {
      let sumEx = 0
      let sumInc = 0
      let count = 0
      for (const t of arr) {
        const pnlEx = typeof t.usdPnLExcludingFee === 'string' ? Number(t.usdPnLExcludingFee) : t.usdPnLExcludingFee
        const fee = typeof t.feeInUSD === 'string' ? Number(t.feeInUSD) : t.feeInUSD
        if (Number.isFinite(pnlEx) && Number.isFinite(fee)) {
          sumEx += pnlEx as number
          sumInc += (pnlEx as number) - (fee as number)
          count += 1
        }
      }
      return count > 0 ? { ex: sumEx / count, inc: sumInc / count } : { ex: null, inc: null }
    }
    return {
      b0_1k: avgPair(pryctoApiBuckets.b0_1k),
      b1k_5k: avgPair(pryctoApiBuckets.b1k_5k),
      b5k_20k: avgPair(pryctoApiBuckets.b5k_20k),
      b20k_50k: avgPair(pryctoApiBuckets.b20k_50k),
      b50k_100k: avgPair(pryctoApiBuckets.b50k_100k),
      b100k_500k: avgPair(pryctoApiBuckets.b100k_500k),
      b500k_5m: avgPair(pryctoApiBuckets.b500k_5m),
      b5m_plus: avgPair(pryctoApiBuckets.b5m_plus),
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
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50">Execution premium average (bps)</th>
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
                <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b0_1k !== null ? (pryctoApiPremiums.b0_1k as number).toFixed(1) : '-'}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">1k - 5k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b1k_5k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b1k_5k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b1k_5k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b1k_5k.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b1k_5k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b1k_5k.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b1k_5k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b1k_5k)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b1k_5k !== null ? (pryctoApiPremiums.b1k_5k as number).toFixed(1) : '-'}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">5k - 20k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b5k_20k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b5k_20k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b5k_20k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b5k_20k.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b5k_20k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b5k_20k.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b5k_20k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b5k_20k)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b5k_20k !== null ? (pryctoApiPremiums.b5k_20k as number).toFixed(1) : '-'}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">20k - 50k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b20k_50k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b20k_50k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b20k_50k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b20k_50k.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b20k_50k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b20k_50k.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b20k_50k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b20k_50k)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b20k_50k !== null ? (pryctoApiPremiums.b20k_50k as number).toFixed(1) : '-'}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">50k - 100k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b50k_100k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b50k_100k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b50k_100k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b50k_100k.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b50k_100k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b50k_100k.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b50k_100k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b50k_100k)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b50k_100k !== null ? (pryctoApiPremiums.b50k_100k as number).toFixed(1) : '-'}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">100k - 500k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b100k_500k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b100k_500k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b100k_500k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b100k_500k.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b100k_500k.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b100k_500k.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b100k_500k.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b100k_500k)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b100k_500k !== null ? (pryctoApiPremiums.b100k_500k as number).toFixed(1) : '-'}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">500k - 5m</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b500k_5m.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b500k_5m)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b500k_5m / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b500k_5m.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b500k_5m.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b500k_5m.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b500k_5m.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b500k_5m)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b500k_5m !== null ? (pryctoApiPremiums.b500k_5m as number).toFixed(1) : '-'}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">5m+</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b5m_plus.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b5m_plus)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b5m_plus / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b5m_plus.ex !== null ? `$${formatUSDCCompact(pryctoApiProfits.b5m_plus.ex as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiProfits && pryctoApiProfits.b5m_plus.inc !== null ? `$${formatUSDCCompact(pryctoApiProfits.b5m_plus.inc as number)}` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(pryctoApiBuckets.b5m_plus)?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b5m_plus !== null ? (pryctoApiPremiums.b5m_plus as number).toFixed(1) : '-'}</td>
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


