import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, Legend } from 'recharts'
import { formatUSDCCompact, truncateToDecimals } from './utils/format'
import type { TradesApiResponse, TradeDocument } from './types'
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
  avgExecPremiumBps,
  avgPryctoBidBuyOverWinnerBuy,
} from './utils/avg'

const DEFAULT_TOKEN_A = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const DEFAULT_TOKEN_B = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const CACHE_PREFIX = 'trades-cache-v1'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const PRYCTO_ADDRESS = '0xa97851357e99082762c972f794b2a29e629511a7'

type CacheEntry = { data: TradesApiResponse; cachedAt: number }
function isCacheEntry(value: unknown): value is CacheEntry {
  if (value === null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return 'data' in obj && 'cachedAt' in obj && typeof obj.cachedAt === 'number'
}

// New API adapter
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
  binancePrices?: { sellTokenInUSD?: number; buyTokenInUSD?: number }
}
type ApiResponse = { items: ApiItem[] }

function mapApiItemToTradeDocument(item: ApiItem): import('./types').TradeDocument {
  const bids = (item.competitionData || []).map((b) => ({
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
    binancePrices: item.binancePrices as { sellTokenInUSD: number; buyTokenInUSD: number } | undefined,
  }
}

function deriveAnalytics(doc: import('./types').TradeDocument): import('./types').TradeDocument {
  const sellPx = (doc.binancePrices as { sellTokenInUSD?: number } | undefined)?.sellTokenInUSD
  const buyPx = (doc.binancePrices as { buyTokenInUSD?: number } | undefined)?.buyTokenInUSD
  const buyUsdcPrice = Number.isFinite(buyPx) ? (buyPx as number) : undefined
  const sellUsdcPrice = Number.isFinite(sellPx) ? (sellPx as number) : undefined
  let orderSellValueUsd: number | undefined
  let orderBuyValueUsd: number | undefined
  if (Number.isFinite(sellPx)) {
    const decimals = { '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 8 } as Record<string, number>
    const tokenLc = doc.sellToken.toLowerCase()
    const dec = decimals[tokenLc] ?? 18
    orderSellValueUsd = (Number(doc.sellAmount) / 10 ** dec) * (sellPx as number)
  }
  if (Number.isFinite(buyPx)) {
    const decimals = { '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, '0xdac17f958d2ee523a2206206994597c13d831ec7': 6, '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 8 } as Record<string, number>
    const tokenLc = doc.buyToken.toLowerCase()
    const dec = decimals[tokenLc] ?? 18
    orderBuyValueUsd = (Number(doc.buyAmount) / 10 ** dec) * (buyPx as number)
  }
  return { ...doc, buyUsdcPrice, sellUsdcPrice, orderSellValueUsd, orderBuyValueUsd }
}
// Averaging helpers: map TradeDocument[] to required avg.ts input shapes
const toExecOnlyInput = (arr: TradeDocument[]) =>
  arr.map((d) => ({ sellToken: d.sellToken, buyToken: d.buyToken, sellAmount: d.sellAmount, buyAmount: d.buyAmount, pryctoApiPrice: (d as { pryctoApiPrice?: number }).pryctoApiPrice }))

const toMarketOnlyInput = (arr: TradeDocument[]) =>
  arr
    .filter((d) => Number.isFinite(d.buyUsdcPrice) && Number.isFinite(d.sellUsdcPrice))
    .map((d) => ({ buyToken: d.buyToken, sellToken: d.sellToken, buyUsdcPrice: d.buyUsdcPrice as number, sellUsdcPrice: d.sellUsdcPrice as number, pryctoApiPrice: (d as { pryctoApiPrice?: number }).pryctoApiPrice }))

const toExecVsMarketInput = (arr: TradeDocument[]) =>
  arr
    .filter((d) => Number.isFinite(d.buyUsdcPrice) && Number.isFinite(d.sellUsdcPrice))
    .map((d) => ({ buyToken: d.buyToken, sellToken: d.sellToken, sellAmount: d.sellAmount, buyAmount: d.buyAmount, buyUsdcPrice: d.buyUsdcPrice as number, sellUsdcPrice: d.sellUsdcPrice as number }))

export default function App() {
  const [buckets, setBuckets] = useState<TradeBuckets | null>(null)
  const [pryctoApiBuckets, setPryctoApiBuckets] = useState<TradeBuckets | null>(null)
  const [missingCounts, setMissingCounts] = useState<Record<string, number>>({})
  const [rawResponse, setRawResponse] = useState<TradesApiResponse | null>(null)
  const [timeSpan, setTimeSpan] = useState<'yesterday' | 'last7' | 'last30'>('yesterday')
  const [tokenA, setTokenA] = useState<string>(DEFAULT_TOKEN_A)
  const [tokenB, setTokenB] = useState<string>(DEFAULT_TOKEN_B)
  const cacheKey = useMemo(() => `${CACHE_PREFIX}-${tokenA.toLowerCase()}-${tokenB.toLowerCase()}` , [tokenA, tokenB])
  const showMissing = false
  // Non-winning Prycto bidder dataset
  const [pryctoNonWinBuckets, setPryctoNonWinBuckets] = useState<TradeBuckets | null>(null)
  // Prycto win-rate time series (per day)
  const [pryctoWinSeries, setPryctoWinSeries] = useState<{ day: string; wins: number; total: number; rate: number }[] | null>(null)
  // Prycto daily won volume (USD) time series
  const [pryctoWinVolSeries, setPryctoWinVolSeries] = useState<{ day: string; volume: number }[] | null>(null)
  // Removed avgMarketWethPrice and avgPryctoWethPrice since columns were hidden
  console.log('pryctoApiBuckets', pryctoApiBuckets)

  // Recharts data: win rate with 7d MA
  const winRateChartData = useMemo(() => {
    if (!pryctoWinSeries) return null
    const series = pryctoWinSeries
    const windowSize = 7
    return series.map((s, i) => {
      const start = Math.max(0, i - (windowSize - 1))
      let wins = 0
      let total = 0
      for (let j = start; j <= i; j++) {
        wins += series[j].wins
        total += series[j].total
      }
      const ma = total > 0 ? wins / total : 0
      return { day: s.day, dailyPct: s.rate * 100, ma7Pct: ma * 100 }
    })
  }, [pryctoWinSeries])

  // Recharts data: won volume with 7d MA (simple mean)
  const winVolChartData = useMemo(() => {
    if (!pryctoWinVolSeries) return null
    const series = pryctoWinVolSeries
    const windowSize = 7
    return series.map((s, i) => {
      const start = Math.max(0, i - (windowSize - 1))
      let sum = 0
      let cnt = 0
      for (let j = start; j <= i; j++) {
        sum += series[j].volume
        cnt += 1
      }
      const ma = cnt > 0 ? sum / cnt : 0
      return { day: s.day, volume: s.volume, ma7Volume: ma }
    })
  }, [pryctoWinVolSeries])

  // Daily volume by direction (TokenA→TokenB vs TokenB→TokenA) for selected timespan
  const dailyDirChartData = useMemo(() => {
    if (!rawResponse) return null
    const now = new Date()
    const endSec = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000)
    const daySec = 24 * 60 * 60
    const startSec =
      timeSpan === 'yesterday'
        ? endSec - daySec
        : timeSpan === 'last7'
        ? endSec - 7 * daySec
        : endSec - 30 * daySec

    const a = tokenA.toLowerCase()
    const b = tokenB.toLowerCase()
    const dayTo = new Map<string, { aToB: number; bToA: number }>()
    for (const d of rawResponse.documents) {
      const tsRaw = (d as { blockTimestamp?: number | string }).blockTimestamp
      const ts = typeof tsRaw === 'string' ? Number(tsRaw) : tsRaw
      if (!Number.isFinite(ts)) continue
      if ((ts as number) < startSec || (ts as number) >= endSec) continue
      const sellLc = (d.sellToken || '').toLowerCase()
      const buyLc = (d.buyToken || '').toLowerCase()
      if (!((sellLc === a && buyLc === b) || (sellLc === b && buyLc === a))) continue
      const volRaw = (d as { orderSellValueUsd?: number | string }).orderSellValueUsd
      const vol = typeof volRaw === 'string' ? Number(volRaw) : volRaw
      if (!Number.isFinite(vol)) continue
      const day = toDay(ts as number)
      if (!dayTo.has(day)) dayTo.set(day, { aToB: 0, bToA: 0 })
      const entry = dayTo.get(day) as { aToB: number; bToA: number }
      if (sellLc === a && buyLc === b) entry.aToB += vol as number
      else entry.bToA += vol as number
    }
    return Array.from(dayTo.entries())
      .map(([day, v]) => ({ day, ...v }))
      .sort((x, y) => (x.day < y.day ? -1 : 1))
  }, [rawResponse, timeSpan, tokenA, tokenB])

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

      const docsWithSellValue = valid.filter((d) => {
        const raw = (d as { orderSellValueUsd?: number | string }).orderSellValueUsd
        const v = typeof raw === 'string' ? Number(raw) : raw
        return Number.isFinite(v)
      })
      const newBuckets = splitTradesBySellValueUsd(docsWithSellValue)
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
      const newPryctoNonWinBuckets = splitTradesBySellValueUsd(pryctoNonWinDocs.filter((d) => {
        const raw = (d as { orderSellValueUsd?: number | string }).orderSellValueUsd
        const v = typeof raw === 'string' ? Number(raw) : raw
        return Number.isFinite(v)
      }))
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
    const sum = (arr: { orderSellValueUsd?: number | string }[]) =>
      arr.reduce((acc, t) => {
        const raw = t.orderSellValueUsd
        const v = typeof raw === 'string' ? Number(raw) : raw
        return Number.isFinite(v) ? acc + (v as number) : acc
      }, 0)
    return {
      b0_1k: sum(buckets.b0_1k),
      b1k_5k: sum(buckets.b1k_5k),
      b5k_20k: sum(buckets.b5k_20k),
      b20k_50k: sum(buckets.b20k_50k),
      b50k_100k: sum(buckets.b50k_100k),
      b100k_250k: sum(buckets.b100k_250k),
      b250k_500k: sum(buckets.b250k_500k),
      b500k_5m: sum(buckets.b500k_5m),
      b5m_plus: sum(buckets.b5m_plus),
    }
  }, [buckets])

  const pryctoNonWinVolumes = useMemo(() => {
    if (!pryctoNonWinBuckets) return null
    const sum = (arr: { orderSellValueUsd?: number | string }[]) =>
      arr.reduce((acc, t) => {
        const raw = t.orderSellValueUsd
        const v = typeof raw === 'string' ? Number(raw) : raw
        return Number.isFinite(v) ? acc + (v as number) : acc
      }, 0)
    return {
      b0_1k: sum(pryctoNonWinBuckets.b0_1k),
      b1k_5k: sum(pryctoNonWinBuckets.b1k_5k),
      b5k_20k: sum(pryctoNonWinBuckets.b5k_20k),
      b20k_50k: sum(pryctoNonWinBuckets.b20k_50k),
      b50k_100k: sum(pryctoNonWinBuckets.b50k_100k),
      b100k_250k: sum(pryctoNonWinBuckets.b100k_250k),
      b250k_500k: sum(pryctoNonWinBuckets.b250k_500k),
      b500k_5m: sum(pryctoNonWinBuckets.b500k_5m),
      b5m_plus: sum(pryctoNonWinBuckets.b5m_plus),
    }
  }, [pryctoNonWinBuckets])

  const premiums = useMemo(() => {
    if (!buckets) return null
    const toAvgInput = (arr: TradeDocument[]) =>
      arr
        .filter((d) => Number.isFinite(d.buyUsdcPrice) && Number.isFinite(d.sellUsdcPrice))
        .map((d) => ({
          buyToken: d.buyToken,
          sellToken: d.sellToken,
          sellAmount: d.sellAmount,
          buyAmount: d.buyAmount,
          buyUsdcPrice: (d.buyUsdcPrice as number),
          sellUsdcPrice: (d.sellUsdcPrice as number),
        }))
    return {
      b0_1k: avgExecPremiumBps(toAvgInput(buckets.b0_1k)),
      b1k_5k: avgExecPremiumBps(toAvgInput(buckets.b1k_5k)),
      b5k_20k: avgExecPremiumBps(toAvgInput(buckets.b5k_20k)),
      b20k_50k: avgExecPremiumBps(toAvgInput(buckets.b20k_50k)),
      b50k_100k: avgExecPremiumBps(toAvgInput(buckets.b50k_100k)),
      b100k_250k: avgExecPremiumBps(toAvgInput(buckets.b100k_250k)),
      b250k_500k: avgExecPremiumBps(toAvgInput(buckets.b250k_500k)),
      b500k_5m: avgExecPremiumBps(toAvgInput(buckets.b500k_5m)),
      b5m_plus: avgExecPremiumBps(toAvgInput(buckets.b5m_plus)),
    }
  }, [buckets])

  // Removed profit computations due to lack of PnL fields in new API

  // Removed non-winning profit computations

  const totals = useMemo(() => {
    if (!buckets) return null
    const totalOrders =
      buckets.b0_1k.length +
      buckets.b1k_5k.length +
      buckets.b5k_20k.length +
      buckets.b20k_50k.length +
      buckets.b50k_100k.length +
      buckets.b100k_250k.length +
      buckets.b250k_500k.length +
      buckets.b500k_5m.length +
      buckets.b5m_plus.length
    const totalVolume = volumes
      ? volumes.b0_1k +
        volumes.b1k_5k +
        volumes.b5k_20k +
        volumes.b20k_50k +
        volumes.b50k_100k +
        volumes.b100k_250k +
        volumes.b250k_500k +
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
      pryctoNonWinBuckets.b100k_250k.length +
      pryctoNonWinBuckets.b250k_500k.length +
      pryctoNonWinBuckets.b500k_5m.length +
      pryctoNonWinBuckets.b5m_plus.length
    const totalVolume = pryctoNonWinVolumes
      ? pryctoNonWinVolumes.b0_1k +
        pryctoNonWinVolumes.b1k_5k +
        pryctoNonWinVolumes.b5k_20k +
        pryctoNonWinVolumes.b20k_50k +
        pryctoNonWinVolumes.b50k_100k +
        pryctoNonWinVolumes.b100k_250k +
        pryctoNonWinVolumes.b250k_500k +
        pryctoNonWinVolumes.b500k_5m +
        pryctoNonWinVolumes.b5m_plus
      : 0
    return { totalOrders, totalVolume }
  }, [pryctoNonWinBuckets, pryctoNonWinVolumes])

  const pryctoApiVolumes = useMemo(() => {
    if (!pryctoApiBuckets) return null
    const sum = (arr: { orderSellValueUsd?: number | string }[]) =>
      arr.reduce((acc, t) => {
        const raw = t.orderSellValueUsd
        const v = typeof raw === 'string' ? Number(raw) : raw
        return Number.isFinite(v) ? acc + (v as number) : acc
      }, 0)
    return {
      b0_1k: sum(pryctoApiBuckets.b0_1k),
      b1k_5k: sum(pryctoApiBuckets.b1k_5k),
      b5k_20k: sum(pryctoApiBuckets.b5k_20k),
      b20k_50k: sum(pryctoApiBuckets.b20k_50k),
      b50k_100k: sum(pryctoApiBuckets.b50k_100k),
      b100k_250k: sum(pryctoApiBuckets.b100k_250k),
      b250k_500k: sum(pryctoApiBuckets.b250k_500k),
      b500k_5m: sum(pryctoApiBuckets.b500k_5m),
      b5m_plus: sum(pryctoApiBuckets.b5m_plus),
    }
  }, [pryctoApiBuckets])

  

  // Removed Prycto API profit computations

  const pryctoApiTotals = useMemo(() => {
    if (!pryctoApiBuckets) return null
    const totalOrders =
      pryctoApiBuckets.b0_1k.length +
      pryctoApiBuckets.b1k_5k.length +
      pryctoApiBuckets.b5k_20k.length +
      pryctoApiBuckets.b20k_50k.length +
      pryctoApiBuckets.b50k_100k.length +
      pryctoApiBuckets.b100k_250k.length +
      pryctoApiBuckets.b250k_500k.length +
      pryctoApiBuckets.b500k_5m.length +
      pryctoApiBuckets.b5m_plus.length
    const totalVolume = pryctoApiVolumes
      ? pryctoApiVolumes.b0_1k +
        pryctoApiVolumes.b1k_5k +
        pryctoApiVolumes.b5k_20k +
        pryctoApiVolumes.b20k_50k +
        pryctoApiVolumes.b50k_100k +
        pryctoApiVolumes.b100k_250k +
        pryctoApiVolumes.b250k_500k +
        pryctoApiVolumes.b500k_5m +
        pryctoApiVolumes.b5m_plus
      : 0
    return { totalOrders, totalVolume }
  }, [pryctoApiBuckets, pryctoApiVolumes])

  useEffect(() => {
    const abortController = new AbortController()


    async function fetchData() {
      try {
        const apiBase = 'https://cowswap-data-api.la-tribu.xyz'
        const url = new URL(apiBase + '/trades', window.location.origin)
        url.searchParams.set('tokenA', tokenA)
        url.searchParams.set('tokenB', tokenB)

        const response = await fetch(url.toString(), { signal: abortController.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const contentType = response.headers.get('content-type') || ''
        if (!contentType.includes('application/json')) {
          const txt = await response.text()
          throw new Error(`Unexpected response content-type: ${contentType}. Body: ${txt.slice(0, 200)}`)
        }
        const raw = (await response.json()) as ApiResponse | TradesApiResponse
        const items = Array.isArray((raw as ApiResponse).items)
          ? (raw as ApiResponse).items
          : Array.isArray((raw as TradesApiResponse).documents)
          ? (raw as TradesApiResponse).documents
          : []
        const mapped = (items as ApiItem[]).map(mapApiItemToTradeDocument).map(deriveAnalytics)
        const json: TradesApiResponse = { documents: mapped }
        console.log('JSON (mapped):', json)
        setRawResponse(json)
        // Always render, even if caching fails
        // Processing is triggered by the rawResponse/timeSpan effect
        try {
          localStorage.setItem(cacheKey, JSON.stringify({ data: json, cachedAt: Date.now() }))
        } catch (cacheError) {
          console.warn('Failed to cache response (likely quota exceeded):', cacheError)
        }
      } catch (error) {
        if ((error as { name?: string } | null)?.name !== 'AbortError') {
          console.error('Failed to fetch data:', error)
          // End loading state with empty dataset so UI doesn't hang
          setRawResponse({ documents: [] })
        }
      }
    }

    try {
      const cached = localStorage.getItem(cacheKey)
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
          // Derive analytics on legacy documents
          setRawResponse({ documents: (legacy.documents || []).map(deriveAnalytics) })
          fetchData()
          return () => abortController.abort()
        }
      }
    } catch (e) {
      console.warn('Failed to load cache:', e)
    }

    fetchData()
    return () => abortController.abort()
  }, [tokenA, tokenB, cacheKey])

  useEffect(() => {
    if (rawResponse) {
      processResponse(rawResponse, timeSpan)
    }
  }, [timeSpan, rawResponse, processResponse])

  function tokenSymbol(addr: string): string {
    const a = addr.toLowerCase()
    if (a === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') return 'USDC'
    if (a === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2') return 'WETH'
    if (a === '0xdac17f958d2ee523a2206206994597c13d831ec7') return 'USDT'
    if (a === '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599') return 'WBTC'
    if (a === '0x4c9edd5852cd905f086c759e8383e09bff1e68b3') return 'USDE'
    return addr.slice(0, 6)
  }
  const pairLabel = `${tokenSymbol(tokenA)}/${tokenSymbol(tokenB)}`

  return buckets === null ? (
    <div>
      <div style={{ borderBottom: '1px solid #e5e7eb', background: '#ffffff' }}>
        <div style={{ maxWidth: 960, margin: '0 auto', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ fontWeight: 600 }}>Mainnet Analytics</div>
          <nav style={{ display: 'flex', gap: 12 }}>
            <Link to="/">Home</Link>
            <Link to="/trades">Trades</Link>
            <Link to="/competition">Competition</Link>
            <Link to="/order">Order</Link>
          </nav>
        </div>
      </div>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
        <h1>Hello world</h1>
        <p>Loading data…</p>
      </div>
    </div>
  ) : (
    <div>
      <div style={{ borderBottom: '1px solid #e5e7eb', background: '#ffffff' }}>
        <div style={{ maxWidth: 960, margin: '0 auto', padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ fontWeight: 600 }}>Mainnet Analytics</div>
          <nav style={{ display: 'flex', gap: 12 }}>
            <Link to="/">Home</Link>
            <Link to="/trades">Trades</Link>
            <Link to="/competition">Competition</Link>
            <Link to="/order">Order</Link>
          </nav>
        </div>
      </div>
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
        <span style={{ marginLeft: 12 }} />
        <label htmlFor="token-a">Token A</label>
        <select id="token-a" value={tokenA} onChange={(e) => setTokenA(e.target.value)}>
          <option value="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48">USDC</option>
          <option value="0xdac17f958d2ee523a2206206994597c13d831ec7">USDT</option>
          <option value="0x2260fac5e5542a773aa44fbcfedf7c193bc2c599">WBTC</option>
          <option value="0x4c9edd5852cd905f086c759e8383e09bff1e68b3">USDE</option>
          <option value="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2">WETH</option>
        </select>
        <span style={{ marginLeft: 8 }} />
        <label htmlFor="token-b">Token B</label>
        <select id="token-b" value={tokenB} onChange={(e) => setTokenB(e.target.value)}>
          <option value="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48">USDC</option>
          <option value="0xdac17f958d2ee523a2206206994597c13d831ec7">USDT</option>
          <option value="0x2260fac5e5542a773aa44fbcfedf7c193bc2c599">WBTC</option>
          <option value="0x4c9edd5852cd905f086c759e8383e09bff1e68b3">USDE</option>
          <option value="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2">WETH</option>
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
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem' }}>
          <div>Pair</div>
          <div>{pairLabel}</div>
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
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b0_1k !== null ? (premiums.b0_1k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">1k - 5k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b1k_5k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b1k_5k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b1k_5k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b1k_5k !== null ? (premiums.b1k_5k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5k - 20k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b5k_20k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b5k_20k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b5k_20k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b5k_20k !== null ? (premiums.b5k_20k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">20k - 50k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b20k_50k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b20k_50k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b20k_50k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b20k_50k !== null ? (premiums.b20k_50k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">50k - 100k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b50k_100k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b50k_100k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b50k_100k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b50k_100k !== null ? (premiums.b50k_100k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">100k - 250k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b100k_250k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b100k_250k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b100k_250k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b100k_250k !== null ? (premiums.b100k_250k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">250k - 500k</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b250k_500k.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b250k_500k)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b250k_500k / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b250k_500k !== null ? (premiums.b250k_500k as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">500k - 5m</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b500k_5m.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b500k_5m)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b500k_5m / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b500k_5m !== null ? (premiums.b500k_5m as number).toFixed(1) : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5m+</td>
            <td className="px-4 py-2 border-b text-right">{buckets.b5m_plus.length.toLocaleString()}</td>
            <td className="px-4 py-2 border-b text-right">{volumes ? `$${formatUSDCCompact(volumes.b5m_plus)}` : '$0'}</td>
            <td className="px-4 py-2 border-b text-right">{totals && volumes && totals.totalVolume > 0 ? `${((volumes.b5m_plus / totals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{premiums && premiums.b5m_plus !== null ? (premiums.b5m_plus as number).toFixed(1) : '-'}</td>
          </tr>
        </tbody>
      </table>

      {dailyDirChartData && dailyDirChartData.length > 0 && (
        <>
          <h2 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: 600 }}>Daily volume by direction</h2>
          {dailyDirChartData.length === 1 ? (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem' }}>
              {(() => {
                const only = dailyDirChartData[0]
                const aToB = only.aToB
                const bToA = only.bToA
                return (
                  <div style={{ display: 'flex', gap: '1rem', alignItems: 'stretch', flexWrap: 'wrap' }}>
                    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
                      <div>{`${tokenSymbol(tokenA)} → ${tokenSymbol(tokenB)}`}</div>
                      <div>{`$${formatUSDCCompact(aToB)}`}</div>
                    </div>
                    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
                      <div>{`${tokenSymbol(tokenB)} → ${tokenSymbol(tokenA)}`}</div>
                      <div>{`$${formatUSDCCompact(bToA)}`}</div>
                    </div>
                  </div>
                )
              })()}
              <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>
                Yesterday's USD volume split by direction for the selected pair.
              </div>
            </div>
          ) : (
            <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem' }}>
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={dailyDirChartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid stroke="#f3f4f6" />
                  <XAxis dataKey="day" tick={{ fontSize: 12 }} angle={-45} textAnchor="end" height={50} />
                  <YAxis tickFormatter={(v) => `$${formatUSDCCompact(v as number)}`} width={70} />
                  <Tooltip formatter={(v: number) => `$${formatUSDCCompact(v as number)}`} labelFormatter={(label) => `${label}`} />
                  <Legend />
                  <Line type="monotone" dataKey="aToB" name={`${tokenSymbol(tokenA)} → ${tokenSymbol(tokenB)}`} stroke="#2563eb" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="bToA" name={`${tokenSymbol(tokenB)} → ${tokenSymbol(tokenA)}`} stroke="#f59e0b" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
              <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>
                Daily USD volume split by trade direction for the selected pair and timespan.
              </div>
            </div>
          )}
        </>
      )}

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
            <td className="px-4 py-2 border-b text-right">{pryctoBuckets ? pryctoBuckets.b100k_250k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiPremiums && pryctoApiPremiums.b100k_250k !== null ? (pryctoApiPremiums.b100k_250k as number).toFixed(1) : '-'}</td>
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

      {winRateChartData && winRateChartData.length > 0 && (
        <>
          <h2 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: 600 }}>Prycto win rate over time</h2>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem' }}>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={winRateChartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid stroke="#f3f4f6" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} angle={-45} textAnchor="end" height={50} />
                <YAxis domain={[0, 60]} tickFormatter={(v) => `${Math.round(v as number)}%`} width={60} />
                <Tooltip formatter={(v: number) => `${(v as number).toFixed(1)}%`} labelFormatter={(label) => `${label}`} />
                <Legend />
                <Line type="monotone" dataKey="dailyPct" name="Daily" stroke="#93c5fd" strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="ma7Pct" name="7-day MA" stroke="#2563eb" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>
              Win rate = wins / participations where Prycto bid is present; per UTC day. Y-axis capped at 60%.
            </div>
          </div>
        </>
      )}

      {winVolChartData && winVolChartData.length > 0 && (
        <>
          <h2 style={{ marginTop: '1.5rem', marginBottom: '0.5rem', fontWeight: 600 }}>Prycto won volume over time</h2>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '0.75rem 1rem' }}>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={winVolChartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid stroke="#f3f4f6" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} angle={-45} textAnchor="end" height={50} />
                <YAxis tickFormatter={(v) => `$${formatUSDCCompact(v as number)}`} width={70} />
                <Tooltip formatter={(v: number) => `$${formatUSDCCompact(v as number)}`} labelFormatter={(label) => `${label}`} />
                <Legend />
                <Line type="monotone" dataKey="volume" name="Daily volume" stroke="#93c5fd" strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="ma7Volume" name="7-day MA" stroke="#2563eb" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ marginTop: 8, color: '#6b7280', fontSize: 12 }}>
              Daily won volume: sum of orderSellValueUsd for orders where Prycto is the winner; per UTC day.
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
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(toExecOnlyInput(pryctoApiBuckets.b0_1k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(toMarketOnlyInput(pryctoApiBuckets.b0_1k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(toExecVsMarketInput(pryctoApiBuckets.b0_1k))?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">1k - 5k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b1k_5k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(toExecOnlyInput(pryctoApiBuckets.b1k_5k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(toMarketOnlyInput(pryctoApiBuckets.b1k_5k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(toExecVsMarketInput(pryctoApiBuckets.b1k_5k))?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5k - 20k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b5k_20k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(toExecOnlyInput(pryctoApiBuckets.b5k_20k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(toMarketOnlyInput(pryctoApiBuckets.b5k_20k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(toExecVsMarketInput(pryctoApiBuckets.b5k_20k))?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">20k - 50k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b20k_50k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(toExecOnlyInput(pryctoApiBuckets.b20k_50k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(toMarketOnlyInput(pryctoApiBuckets.b20k_50k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(toExecVsMarketInput(pryctoApiBuckets.b20k_50k))?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">50k - 100k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b50k_100k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(toExecOnlyInput(pryctoApiBuckets.b50k_100k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(toMarketOnlyInput(pryctoApiBuckets.b50k_100k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(toExecVsMarketInput(pryctoApiBuckets.b50k_100k))?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">100k - 250k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b100k_250k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(toExecOnlyInput(pryctoApiBuckets.b100k_250k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(toMarketOnlyInput(pryctoApiBuckets.b100k_250k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(toExecVsMarketInput(pryctoApiBuckets.b100k_250k))?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">250k - 500k</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b250k_500k.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(toExecOnlyInput(pryctoApiBuckets.b250k_500k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(toMarketOnlyInput(pryctoApiBuckets.b250k_500k))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(toExecVsMarketInput(pryctoApiBuckets.b250k_500k))?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">500k - 5m</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b500k_5m.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(toExecOnlyInput(pryctoApiBuckets.b500k_5m))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(toMarketOnlyInput(pryctoApiBuckets.b500k_5m))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(toExecVsMarketInput(pryctoApiBuckets.b500k_5m))?.toFixed(2) ?? '-').toString() : '-'}</td>
          </tr>
          <tr className="odd:bg-white even:bg-gray-50">
            <td className="px-4 py-2 border-b">5m+</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? pryctoApiBuckets.b5m_plus.length.toLocaleString() : 0}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaVsExecutionPct(toExecOnlyInput(pryctoApiBuckets.b5m_plus))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaWethPrice(toMarketOnlyInput(pryctoApiBuckets.b5m_plus))?.toFixed(2) ?? '-').toString() : '-'}</td>
            <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets ? (avgDeltaExecVsMarketPct(toExecVsMarketInput(pryctoApiBuckets.b5m_plus))?.toFixed(2) ?? '-').toString() : '-'}</td>
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
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(toMarketOnlyInput(pryctoApiBuckets.b0_1k))?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(toExecVsMarketInput(pryctoApiBuckets.b0_1k))?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">1k - 5k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b1k_5k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b1k_5k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b1k_5k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(toMarketOnlyInput(pryctoApiBuckets.b1k_5k))?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(toExecVsMarketInput(pryctoApiBuckets.b1k_5k))?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">5k - 20k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b5k_20k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b5k_20k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b5k_20k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(toMarketOnlyInput(pryctoApiBuckets.b5k_20k))?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(toExecVsMarketInput(pryctoApiBuckets.b5k_20k))?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">20k - 50k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b20k_50k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b20k_50k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b20k_50k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(toMarketOnlyInput(pryctoApiBuckets.b20k_50k))?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(toExecVsMarketInput(pryctoApiBuckets.b20k_50k))?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">50k - 100k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b50k_100k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b50k_100k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b50k_100k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(toMarketOnlyInput(pryctoApiBuckets.b50k_100k))?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(toExecVsMarketInput(pryctoApiBuckets.b50k_100k))?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">100k - 250k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b100k_250k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b100k_250k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b100k_250k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(toMarketOnlyInput(pryctoApiBuckets.b100k_250k))?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(toExecVsMarketInput(pryctoApiBuckets.b100k_250k))?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">250k - 500k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b250k_500k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b250k_500k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b250k_500k / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(toMarketOnlyInput(pryctoApiBuckets.b250k_500k))?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(toExecVsMarketInput(pryctoApiBuckets.b250k_500k))?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">500k - 5m</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b500k_5m.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b500k_5m)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b500k_5m / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(toMarketOnlyInput(pryctoApiBuckets.b500k_5m))?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(toExecVsMarketInput(pryctoApiBuckets.b500k_5m))?.toFixed(1) ?? '-').toString()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">5m+</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiBuckets.b5m_plus.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiVolumes ? `$${formatUSDCCompact(pryctoApiVolumes.b5m_plus)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoApiTotals && pryctoApiVolumes && pryctoApiTotals.totalVolume > 0 ? `${((pryctoApiVolumes.b5m_plus / pryctoApiTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(avgPryctoPremiumBps(toMarketOnlyInput(pryctoApiBuckets.b5m_plus))?.toFixed(1) ?? '-').toString()}</td>
                <td className="px-4 py-2 border-b text-right">{(avgExecPremiumBps(toExecVsMarketInput(pryctoApiBuckets.b5m_plus))?.toFixed(1) ?? '-').toString()}</td>
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
                <th className="px-4 py-2 text-right text-sm font-semibold text-gray-700 border-b bg-gray-50" title={'Average over docs of (Prycto bid buyAmount / Winner bid buyAmount), amounts normalized to token decimals'}>Prycto buyAmount / Winner buyAmount (avg)</th>
              </tr>
            </thead>
            <tbody>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">0 - 1k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b0_1k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b0_1k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b0_1k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b0_1k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">1k - 5k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b1k_5k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b1k_5k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b1k_5k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b1k_5k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">5k - 20k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b5k_20k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b5k_20k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b5k_20k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b5k_20k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">20k - 50k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b20k_50k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b20k_50k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b20k_50k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b20k_50k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">50k - 100k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b50k_100k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b50k_100k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b50k_100k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b50k_100k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">100k - 250k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b100k_250k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b100k_250k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b100k_250k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b100k_250k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">250k - 500k</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b250k_500k.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b250k_500k)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b250k_500k / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b250k_500k, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">500k - 5m</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b500k_5m.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b500k_5m)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b500k_5m / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
                <td className="px-4 py-2 border-b text-right">{(() => { const v = avgPryctoBidBuyOverWinnerBuy(pryctoNonWinBuckets.b500k_5m, PRYCTO_ADDRESS); return v === null ? '-' : truncateToDecimals(v, 6) })()}</td>
              </tr>
              <tr className="odd:bg-white even:bg-gray-50">
                <td className="px-4 py-2 border-b">5m+</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinBuckets.b5m_plus.length.toLocaleString()}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinVolumes ? `$${formatUSDCCompact(pryctoNonWinVolumes.b5m_plus)}` : '$0'}</td>
                <td className="px-4 py-2 border-b text-right">{pryctoNonWinTotals && pryctoNonWinVolumes && pryctoNonWinTotals.totalVolume > 0 ? `${((pryctoNonWinVolumes.b5m_plus / pryctoNonWinTotals.totalVolume) * 100).toFixed(1)}%` : '-'}</td>
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
    </div>
  )
}


