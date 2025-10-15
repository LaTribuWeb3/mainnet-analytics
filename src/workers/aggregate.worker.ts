/// <reference lib="webworker" />
import { computePriceUSDCPerToken, blockHighUSDCPerBase, blockMidUSDCPerBase, normalizeAmount, TOKENS, toDay, percentDiff, higherPriceIsBetterUSDCPerToken } from '../utils/price'
import type { AggregatesResult, TradeRecord, SolverStats } from '../types'

type FilterCriteria = { fromTs?: number; toTs?: number; direction?: 'USDC_to_WBTC' | 'WBTC_to_USDC' | 'ALL'; minNotional?: number; maxNotional?: number; solverIncludes?: string }
type MsgIn = { type: 'aggregate'; filePath: string; altFileUrl?: string } | { type: 'filter'; criteria: FilterCriteria } | { type: 'hydrate'; index: TradeIdx[] }
type MsgOut =
  | { type: 'progress'; loaded: number }
  | { type: 'done'; data: AggregatesResult }
  | { type: 'filtered'; data: AggregatesResult; criteria?: FilterCriteria }
  | { type: 'error'; error: string }

type TradeIdx = {
  orderUid: string
  ts: number
  direction: 'USDC_to_WBTC' | 'WBTC_to_USDC'
  notionalUSDC: number
  participants: number
  priceMarginPct: number | null
  winner: string
  solvers: string[]
  profitUSDCWithFees: number
  profitUSDCNoFees: number
}

const ctx: DedicatedWorkerGlobalScope = self as any

let GLOBAL_INDEX: TradeIdx[] | null = null

ctx.onmessage = async (ev: MessageEvent<MsgIn>) => {
  try {
    if (ev.data.type === 'hydrate') {
      GLOBAL_INDEX = ev.data.index
      return
    }
    if (ev.data.type === 'filter') {
      if (!GLOBAL_INDEX) throw new Error('No index present; load data first')
      const out = computeAggregatesFromIndex(GLOBAL_INDEX, ev.data.criteria)
      ctx.postMessage({ type: 'filtered', data: out, criteria: ev.data.criteria } satisfies MsgOut)
      return
    }
    // aggregate
    const { filePath, altFileUrl } = ev.data
    // Try local path first; if content-type looks like HTML, fall back to altFileUrl (API)
    let res = await fetch(filePath, { cache: 'no-store' }).catch(() => null as any)
    const isHtml = (r: Response | null) => {
      if (!r) return false
      const ct = r.headers.get('content-type') || ''
      return ct.includes('text/html')
    }
    if (!res || !res.ok || !res.body || isHtml(res)) {
      if (altFileUrl) {
        res = await fetch(altFileUrl, { cache: 'no-store', headers: { 'accept': 'application/json,text/plain;q=0.9,*/*;q=0.8' } }).catch(() => null as any)
      }
    }
    if (!res || !res.ok || !res.body || isHtml(res)) throw new Error(`Failed to fetch dataset from both sources`)

    // Aggregate metrics
    const solverToStats = new Map<string, SolverStats>()
    let totalTrades = 0
    let totalNotionalUSDC = 0
    let totalParticipants = 0
    let singleBid = 0
    const margins: number[] = []
    const participation: number[] = []
    const dayToData = new Map<string, { trades: number; participants: number }>()
    const tradesPreview: AggregatesResult['tradesPreview'] = []
    const index: TradeIdx[] = []
    const pairWise: Map<string, { wins: number; total: number }> = new Map()
    const solverWinMargins: Map<string, number[]> = new Map()
    const profitsWithFees: number[] = []
    const profitsNoFees: number[] = []
    const profitBySolverWithFees = new Map<string, number>()
    const profitBySolverNoFees = new Map<string, number>()
    
    const processRecord = (trIn: any) => {
      // Normalize API record (supports both TradeRecord and API documents with competitionData)
      const tr: TradeRecord = {
        orderUid: trIn.orderUid || trIn.orderUID || trIn.order_id || trIn._id || 'unknown',
        sellToken: trIn.sellToken,
        buyToken: trIn.buyToken,
        sellAmount: trIn.sellAmount,
        buyAmount: trIn.buyAmount,
        eventBlockNumber: trIn.blockNumber || trIn.eventBlockNumber || 0,
        eventBlockTimestamp: trIn.blockTimestamp || trIn.eventBlockTimestamp || 0,
        eventTxHash: trIn.txHash || trIn.eventTxHash || '',
        txFeeWei: trIn.transactionFee || trIn.txFeeWei || '0',
        competitionSolutions: Array.isArray(trIn.competitionSolutions)
          ? trIn.competitionSolutions
          : (Array.isArray(trIn.competitionData?.bidData)
              ? trIn.competitionData.bidData.map((b: any, idx: number) => ({
                  solverAddress: b.solverAddress,
                  score: '0',
                  ranking: idx + 1,
                  isWinner: !!b.winner,
                  txHash: trIn.txHash || null,
                  referenceScore: null,
                  order: {
                    id: trIn.orderUid || trIn._id || 'unknown',
                    sellAmount: b.sellAmount ?? trIn.sellAmount,
                    buyAmount: b.buyAmount ?? trIn.buyAmount,
                    sellToken: trIn.sellToken,
                    buyToken: trIn.buyToken,
                  },
                }))
              : []) as any,
        eventBlockPrices: (trIn.eventBlockPrices || trIn.blockPrices || {}) as any,
      }
      totalTrades += 1
      const winner = tr.competitionSolutions.find(s => s.isWinner)
      const participants = tr.competitionSolutions?.length || 0
      totalParticipants += participants
      participation.push(participants)
      if (participants === 1) singleBid += 1

      // computePriceUSDCPerBase available via per-solution pricing below
      // Notional USDC using USDC side of the trade
      const sellLc = (tr.sellToken || '').toLowerCase()
      const buyLc = (tr.buyToken || '').toLowerCase()
      let notionalUSDCForTrade = 0
      if (sellLc === TOKENS.USDC) notionalUSDCForTrade = normalizeAmount(tr.sellAmount, tr.sellToken)
      else if (buyLc === TOKENS.USDC) notionalUSDCForTrade = normalizeAmount(tr.buyAmount, tr.buyToken)
      totalNotionalUSDC += notionalUSDCForTrade

      let winnerPrice: number | null = null
      let secondPrice: number | null = null
      let topSolutions: Array<{ solver: string; priceUSDCPerBTC: number | null; rank: number }> | undefined
      if (winner) {
        const solutionPrices = tr.competitionSolutions
          .map(s => ({ s, p: computePriceUSDCPerToken(s.order.sellToken, s.order.buyToken, s.order.sellAmount, s.order.buyAmount) }))
          .filter(x => x.p != null) as Array<{ s: typeof winner; p: number }>

        if (solutionPrices.length > 0) {
          const higherIsBetter = higherPriceIsBetterUSDCPerToken(tr.sellToken, tr.buyToken) ?? true
          solutionPrices.sort((a, b) => higherIsBetter ? b.p - a.p : a.p - b.p)
          winnerPrice = solutionPrices.find(x => x.s.isWinner)?.p ?? null
          const second = solutionPrices.find(x => !x.s.isWinner)
          secondPrice = second?.p ?? null
          // compute margin vs block high
          const benchmark = selectBenchmark(tr.eventBlockPrices as any, 'high')
          if (winnerPrice != null && benchmark != null) {
            const m = percentDiff(winnerPrice, benchmark)
            if (m != null) {
              margins.push(m)
              // capture winner-specific win margin
              if (winner) {
                const list = solverWinMargins.get(winner.solverAddress) ?? []
                list.push(m * 100)
                solverWinMargins.set(winner.solverAddress, list)
              }
            }
          }
          topSolutions = solutionPrices.slice(0, 5).map((x, i) => ({ solver: x.s.solverAddress, priceUSDCPerBTC: x.p, rank: i + 1 }))
        }
      }

      const day = toDay(tr.eventBlockTimestamp || 0)
      const d = dayToData.get(day) ?? { trades: 0, participants: 0 }
      d.trades += 1
      d.participants += participants
      dayToData.set(day, d)

      tradesPreview.push({
        orderUid: tr.orderUid,
        timestamp: tr.eventBlockTimestamp,
        direction: tr.sellToken.toLowerCase() === TOKENS.USDC ? 'USDC_to_WBTC' : 'WBTC_to_USDC',
        notionalUSDC: notionalUSDCForTrade,
        participants,
        winner: winner?.solverAddress ?? 'unknown',
        winnerPriceUSDCPerBTC: winnerPrice,
        secondBestPriceUSDCPerBTC: secondPrice,
        priceMarginPct: (() => {
          const bench = selectBenchmark(tr.eventBlockPrices as any, 'high')
          return (winnerPrice != null && bench != null) ? percentDiff(winnerPrice, bench) : null
        })(),
        topSolutions,
      })

      // index for filtering
      index.push({
        orderUid: tr.orderUid,
        ts: tr.eventBlockTimestamp,
        direction: tr.sellToken.toLowerCase() === TOKENS.USDC ? 'USDC_to_WBTC' : 'WBTC_to_USDC',
        notionalUSDC: notionalUSDCForTrade,
        participants,
        priceMarginPct: (() => {
          const bench = selectBenchmark(tr.eventBlockPrices as any, 'high')
          return (winnerPrice != null && bench != null) ? percentDiff(winnerPrice, bench) : null
        })(),
        winner: winner?.solverAddress ?? 'unknown',
        solvers: Array.from(new Set(tr.competitionSolutions.map(s => s.solverAddress))),
        profitUSDCWithFees: 0,
        profitUSDCNoFees: 0,
      })

      // profit estimation (USDC) vs second-best solution
      if (winnerPrice != null && secondPrice != null) {
        const sellTokenLc = tr.sellToken.toLowerCase()
        const buyTokenLc = tr.buyToken.toLowerCase()
        const higherIsBetter = higherPriceIsBetterUSDCPerToken(tr.sellToken, tr.buyToken) ?? true
        let tokenQty = 0
        if (sellTokenLc === TOKENS.USDC) tokenQty = normalizeAmount(tr.buyAmount, tr.buyToken)
        else if (buyTokenLc === TOKENS.USDC) tokenQty = normalizeAmount(tr.sellAmount, tr.sellToken)
        if (tokenQty > 0) {
          const improvement = higherIsBetter ? (winnerPrice - secondPrice) : (secondPrice - winnerPrice)
          const noFees = Math.max(0, improvement * tokenQty)
          const withFees = noFees // fees ignored for now
          profitsWithFees.push(withFees)
          profitsNoFees.push(noFees)
          if (winner) {
            profitBySolverWithFees.set(winner.solverAddress, (profitBySolverWithFees.get(winner.solverAddress) ?? 0) + withFees)
            profitBySolverNoFees.set(winner.solverAddress, (profitBySolverNoFees.get(winner.solverAddress) ?? 0) + noFees)
          }
          const last = index[index.length - 1]
          if (last && last.orderUid === tr.orderUid) {
            last.profitUSDCWithFees = withFees
            last.profitUSDCNoFees = noFees
          }
        }
      }

      // solver aggregates
      const uniqueSolvers = new Set(tr.competitionSolutions.map(s => s.solverAddress))
      for (const addr of uniqueSolvers) {
        const st = solverToStats.get(addr) ?? { solverAddress: addr, wins: 0, tradesParticipated: 0, volumeUSDC: 0 }
        st.tradesParticipated += 1
        solverToStats.set(addr, st)
      }
      if (winner) {
        const st = solverToStats.get(winner.solverAddress)!
        st.wins += 1
        st.volumeUSDC += notionalUSDCForTrade

        // rivalry: pairwise for all co-participants
        const solvers = Array.from(new Set(tr.competitionSolutions.map(s => s.solverAddress)))
        for (const a of solvers) {
          for (const b of solvers) {
            if (a === b) continue
            const key = `${a}|${b}`
            const rec = pairWise.get(key) ?? { wins: 0, total: 0 }
            rec.total += 1
            if (winner.solverAddress === a) rec.wins += 1
            pairWise.set(key, rec)
          }
        }
      }
    }

    
    // Simpler and more robust: read full text and parse once
    const text = await res.text()
    const cleaned = text.replace(/^\uFEFF/, '').trim()
    if (!(cleaned.startsWith('[') || cleaned.startsWith('{'))) {
      throw new Error(`Dataset is not JSON. First chars: ${cleaned.slice(0, 64)}`)
    }
    const parsed = JSON.parse(cleaned)
    const arr: TradeRecord[] = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed?.documents) ? parsed.documents : [])
    if (!Array.isArray(arr)) throw new Error('Unexpected dataset shape: not an array and no documents[] found')
    for (const tr of arr) processRecord(tr)

    const marginPct = margins.map(x => x * 100)
    const marginHistogram = bucketize(
      marginPct,
      [
        -50, -20, -10, -5, -2, -1,
        -0.5, -0.2, -0.1, -0.05, -0.02, -0.01,
        0,
        0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
        1, 2, 5, 10, 20, 50
      ]
    )
    const participationHistogram = bucketize(participation, [1,2,3,4,5,6,8,10,12,16,20])
    // Size buckets (USDC notional): 0-1k, 1k-10k, 10k-100k, 100k-500k, 500k-2M, 2M+
    const sizeBuckets = [0, 1e3, 1e4, 1e5, 5e5, 2e6]
    const sizeHistogram = bucketize(tradesPreview.map(t => t.notionalUSDC), sizeBuckets)
    const sizeStats = summarize(tradesPreview.map(t => t.notionalUSDC))
    // Single-bid distributions and leaderboard
    const singleBidTrades = tradesPreview.filter(t => t.participants === 1)
    const singleBidSizeHistogram = bucketize(singleBidTrades.map(t => t.notionalUSDC), sizeBuckets)
    const sbStats = summarize(singleBidTrades.map(t => t.notionalUSDC))
    const singleBidSolverLeaderboardMap = new Map<string, { wins: number; vol: number }>()
    for (const t of singleBidTrades) {
      const rec = singleBidSolverLeaderboardMap.get(t.winner) ?? { wins: 0, vol: 0 }
      rec.wins += 1
      rec.vol += t.notionalUSDC
      singleBidSolverLeaderboardMap.set(t.winner, rec)
    }
    const singleBidSolverLeaderboard = Array.from(singleBidSolverLeaderboardMap.entries()).sort((a,b) => b[1].wins - a[1].wins).slice(0, 15).map(([solverAddress, r]) => ({ solverAddress, singleBidWins: r.wins, singleBidVolumeUSDC: r.vol }))
    const dailySeries = Array.from(dayToData.entries()).sort((a,b) => a[0].localeCompare(b[0])).map(([day, d]) => ({ day, trades: d.trades, avgParticipants: d.participants / d.trades }))

    // build rivalry matrix for top solvers by wins
    const topSolvers = Array.from(solverToStats.values()).sort((a,b) => b.wins - a.wins).slice(0, 10).map(s => s.solverAddress)
    const matrix: number[][] = topSolvers.map(a => topSolvers.map(b => {
      if (a === b) return 0
      const key = `${a}|${b}`
      const rec = pairWise.get(key)
      if (!rec || rec.total === 0) return 0
      return rec.wins / rec.total
    }))

    const m = summarize(marginPct)
    const p = summarize(participation)
    // compute top-5 solver analytics
    const solverStatsArr = Array.from(solverToStats.values()).sort((a,b) => b.wins - a.wins)
    const top5 = solverStatsArr.slice(0, 5).map(s => {
      const margins = solverWinMargins.get(s.solverAddress) || []
      const avg = margins.length ? margins.reduce((a,b) => a+b, 0) / margins.length : null
      const p50 = margins.length ? summarize(margins).p50 : null
      for (const s of solverStatsArr) {
        const withFees = profitBySolverWithFees.get(s.solverAddress)
        const noFees = profitBySolverNoFees.get(s.solverAddress)
        if (withFees != null) s.profitUSDCWithFees = withFees
        if (noFees != null) s.profitUSDCNoFees = noFees
      }

      return {
        solverAddress: s.solverAddress,
        wins: s.wins,
        tradesParticipated: s.tradesParticipated,
        winRate: s.tradesParticipated ? s.wins / s.tradesParticipated : 0,
        volumeUSDC: s.volumeUSDC,
        avgWinMarginPct: avg,
        p50WinMarginPct: p50,
      }
    })

    const profFees = profitsWithFees.length ? summarize(profitsWithFees) : { count: 0, min: 0, p25: 0, p50: 0, p75: 0, max: 0, avg: 0 }
    const profNoFees = profitsNoFees.length ? summarize(profitsNoFees) : { count: 0, min: 0, p25: 0, p50: 0, p75: 0, max: 0, avg: 0 }
    const data: AggregatesResult = {
      totalTrades,
      totalNotionalUSDC,
      avgParticipants: totalParticipants / Math.max(1, totalTrades),
      singleBidShare: totalTrades ? singleBid / totalTrades : 0,
      marginHistogram,
      participationHistogram,
      sizeHistogram,
      dailySeries,
      solverStats: solverStatsArr,
      rivalryMatrix: { solvers: topSolvers, matrix },
      topSolverAnalytics: top5,
      tradesPreview: tradesPreview.slice(0, 200),
      participationStats: p,
      marginStats: { count: m.count, minPct: m.min, p25Pct: m.p25, p50Pct: m.p50, p75Pct: m.p75, maxPct: m.max, avgPct: m.avg },
      profitStatsWithFees: { count: profFees.count, totalUSDC: profitsWithFees.reduce((a,b)=>a+b,0), avgUSDC: profFees.avg, p25USDC: profFees.p25, p50USDC: profFees.p50, p75USDC: profFees.p75 },
      profitStatsNoFees: { count: profNoFees.count, totalUSDC: profitsNoFees.reduce((a,b)=>a+b,0), avgUSDC: profNoFees.avg, p25USDC: profNoFees.p25, p50USDC: profNoFees.p50, p75USDC: profNoFees.p75 },
      sizeStats: { count: sizeStats.count, avgUSDC: sizeStats.avg, p25USDC: sizeStats.p25, p50USDC: sizeStats.p50, p75USDC: sizeStats.p75 },
      singleBidSizeHistogram,
      singleBidStats: { count: sbStats.count, avgUSDC: sbStats.avg, p25USDC: sbStats.p25, p50USDC: sbStats.p50, p75USDC: sbStats.p75 },
      singleBidSolverLeaderboard
    }
    GLOBAL_INDEX = index
    ctx.postMessage({ type: 'done', data } satisfies MsgOut)
  } catch (e: any) {
    ctx.postMessage({ type: 'error', error: String(e?.message ?? e) } satisfies MsgOut)
  }
}

function bucketize(values: number[], edges: number[]) {
  const labels: string[] = []
  for (let i = 0; i < edges.length - 1; i++) labels.push(`${edges[i]}..${edges[i+1]}`)
  labels.push(`${edges[edges.length - 1]}+`)
  const counts = new Array(labels.length).fill(0)
  for (const v of values) {
    let placed = false
    for (let i = 0; i < edges.length - 1; i++) {
      if (v >= edges[i] && v < edges[i+1]) { counts[i]++; placed = true; break }
    }
    if (!placed) counts[counts.length - 1]++
  }
  return labels.map((bucket, i) => ({ bucket, count: counts[i] }))
}

function summarize(values: number[]) {
  const n = values.length
  if (n === 0) return { count: 0, min: 0, p25: 0, p50: 0, p75: 0, max: 0, avg: 0 }
  const sorted = [...values].sort((a,b) => a-b)
  const q = (p: number) => {
    const idx = (p/100) * (n - 1)
    const lo = Math.floor(idx), hi = Math.ceil(idx)
    if (lo === hi) return sorted[lo]
    const t = idx - lo
    return sorted[lo] * (1 - t) + sorted[hi] * t
  }
  const sum = values.reduce((a,b) => a+b, 0)
  return {
    count: n,
    min: sorted[0],
    p25: q(25),
    p50: q(50),
    p75: q(75),
    max: sorted[n-1],
    avg: sum / n,
  }
}

function selectBenchmark(prices: any, bench: 'high' | 'mid' | 'low'): number | null {
  if (bench === 'high') return blockHighUSDCPerBase(prices)
  if (bench === 'mid') return blockMidUSDCPerBase(prices)
  // low for USDC/base → convert accordingly
  // approximate using mid when low not available with correct inversion is similar; here we reuse high/mid helpers for simplicity
  // In datasets we usually have high/low; we’ll compute low as: if BTC_USDC/ETH_USDC present, return that.low; else 1/(USDC_BTC/USDC_ETH).high
  if (!prices) return null
  if (prices['BTC_USDC'] || prices['ETH_USDC']) return (prices['BTC_USDC'] ?? prices['ETH_USDC']).low
  if (prices['USDC_BTC'] || prices['USDC_ETH']) {
    const p = prices['USDC_BTC'] ?? prices['USDC_ETH']
    if (p.high === 0) return null
    return 1 / p.high
  }
  return null
}

function computeAggregatesFromIndex(index: TradeIdx[], criteria: FilterCriteria): AggregatesResult {
  const { fromTs, toTs, direction, minNotional, maxNotional, solverIncludes } = criteria
  const filtered = index.filter(t =>
    (fromTs == null || t.ts >= fromTs) &&
    (toTs == null || t.ts <= toTs) &&
    (direction == null || direction === 'ALL' || t.direction === direction) &&
    (minNotional == null || t.notionalUSDC >= minNotional) &&
    (maxNotional == null || t.notionalUSDC <= maxNotional) &&
    (solverIncludes == null || t.solvers.some(s => s.toLowerCase() === solverIncludes.toLowerCase()))
  )

  const totalTrades = filtered.length
  const totalNotionalUSDC = filtered.reduce((a, b) => a + b.notionalUSDC, 0)
  const totalParticipants = filtered.reduce((a, b) => a + b.participants, 0)
  const singleBid = filtered.filter(t => t.participants === 1).length
  const margins = filtered.map(t => t.priceMarginPct).filter((x): x is number => x != null)
  const participation = filtered.map(t => t.participants)
  const dayToData = new Map<string, { trades: number; participants: number }>()

  for (const t of filtered) {
    const day = toDay(t.ts)
    const d = dayToData.get(day) ?? { trades: 0, participants: 0 }
    d.trades += 1
    d.participants += t.participants
    dayToData.set(day, d)
  }

  // solver stats and rivalry
  const solverToStats = new Map<string, SolverStats>()
  const pairWise: Map<string, { wins: number; total: number }> = new Map()
  for (const t of filtered) {
    const uniqueSolvers = new Set(t.solvers)
    for (const a of uniqueSolvers) {
      const st = solverToStats.get(a) ?? { solverAddress: a, wins: 0, tradesParticipated: 0, volumeUSDC: 0 }
      st.tradesParticipated += 1
      solverToStats.set(a, st)
      for (const b of uniqueSolvers) {
        if (a === b) continue
        const key = `${a}|${b}`
        const rec = pairWise.get(key) ?? { wins: 0, total: 0 }
        rec.total += 1
        if (t.winner === a) rec.wins += 1
        pairWise.set(key, rec)
      }
    }
    const winnerSt = solverToStats.get(t.winner) ?? { solverAddress: t.winner, wins: 0, tradesParticipated: 0, volumeUSDC: 0 }
    winnerSt.wins += 1
    winnerSt.volumeUSDC += t.notionalUSDC
    solverToStats.set(t.winner, winnerSt)
  }
  const topSolvers = Array.from(solverToStats.values()).sort((a,b) => b.wins - a.wins).slice(0, 10).map(s => s.solverAddress)
  const matrix: number[][] = topSolvers.map(a => topSolvers.map(b => {
    if (a === b) return 0
    const key = `${a}|${b}`
    const rec = pairWise.get(key)
    if (!rec || rec.total === 0) return 0
    return rec.wins / rec.total
  }))

  const marginHistogram = bucketize(margins.map(x => x * 100), [-50, -20, -10, -5, -2, -1, 0, 1, 2, 5, 10, 20, 50])
  const participationHistogram = bucketize(participation, [1,2,3,4,5,6,8,10,12,16,20])
  const dailySeries = Array.from(dayToData.entries()).sort((a,b) => a[0].localeCompare(b[0])).map(([day, d]) => ({ day, trades: d.trades, avgParticipants: d.participants / d.trades }))

  // profit average for filtered set
  const totalProfit = filtered.reduce((sum, t) => sum + t.profitUSDCNoFees, 0)
  const avgProfitPerTradeUSDC = filtered.length ? totalProfit / filtered.length : 0

  // size-segment analytics
  const sizeEdges = [0, 1e3, 1e4, 1e5, 5e5, 2e6]
  const sizeLabels: string[] = []
  for (let i = 0; i < sizeEdges.length - 1; i++) sizeLabels.push(`${sizeEdges[i]}..${sizeEdges[i+1]}`)
  sizeLabels.push(`${sizeEdges[sizeEdges.length - 1]}+`)
  type BucketAgg = {
    count: number
    volumeUSDC: number
    participantsSum: number
    profitSum: number
    profitBySolver: Map<string, number>
    winBySolver: Map<string, { wins: number; participated: number }>
    volumeBySolver: Map<string, number>
  }
  const buckets: BucketAgg[] = sizeLabels.map(() => ({
    count: 0,
    volumeUSDC: 0,
    participantsSum: 0,
    profitSum: 0,
    profitBySolver: new Map(),
    winBySolver: new Map(),
    volumeBySolver: new Map(),
  }))
  const bucketIndex = (v: number) => {
    for (let i = 0; i < sizeEdges.length - 1; i++) if (v >= sizeEdges[i] && v < sizeEdges[i+1]) return i
    return sizeLabels.length - 1
  }
  for (const t of filtered) {
    const bi = bucketIndex(t.notionalUSDC)
    const b = buckets[bi]
    b.count += 1
    b.volumeUSDC += t.notionalUSDC
    b.participantsSum += t.participants
    const prof = t.profitUSDCNoFees
    b.profitSum += prof
    // profit and volume by solver (winner)
    if (t.winner) {
      b.profitBySolver.set(t.winner, (b.profitBySolver.get(t.winner) ?? 0) + prof)
      b.volumeBySolver.set(t.winner, (b.volumeBySolver.get(t.winner) ?? 0) + t.notionalUSDC)
    }
    // win rate by solver, count participation
    const uniq = new Set(t.solvers)
    for (const s of uniq) {
      const rec = b.winBySolver.get(s) ?? { wins: 0, participated: 0 }
      rec.participated += 1
      if (t.winner === s) rec.wins += 1
      b.winBySolver.set(s, rec)
    }
  }
  const sizeSegments = sizeLabels.map((bucket, i) => {
    const b = buckets[i]
    const topByProfit = Array.from(b.profitBySolver.entries()).sort((a,b) => b[1] - a[1]).slice(0, 5).map(([solverAddress, totalProfitUSDC]) => ({ solverAddress, totalProfitUSDC }))
    const topByWinRate = Array.from(b.winBySolver.entries()).map(([solverAddress, r]) => ({ solverAddress, winRate: r.participated ? r.wins / r.participated : 0, tradesParticipated: r.participated, wins: r.wins })).sort((a,b) => b.winRate - a.winRate).slice(0, 5)
    const topByVolume = Array.from(b.volumeBySolver.entries()).sort((a,b) => b[1] - a[1]).slice(0,5).map(([solverAddress, volumeUSDC]) => ({ solverAddress, volumeUSDC, wins: (b.winBySolver.get(solverAddress)?.wins ?? 0) }))
    return {
      bucket,
      count: b.count,
      volumeUSDC: b.volumeUSDC,
      avgParticipants: b.count ? b.participantsSum / b.count : 0,
      avgProfitPerTradeUSDC: b.count ? b.profitSum / b.count : 0,
      topByProfit,
      topByWinRate,
      topByVolume,
    }
  })

  return {
    totalTrades,
    totalNotionalUSDC,
    avgParticipants: totalTrades ? totalParticipants / totalTrades : 0,
    singleBidShare: totalTrades ? singleBid / totalTrades : 0,
    marginHistogram,
    participationHistogram,
    sizeHistogram: bucketize(filtered.map(t => t.notionalUSDC), sizeEdges),
    dailySeries,
    solverStats: Array.from(solverToStats.values()).sort((a,b) => b.wins - a.wins),
    rivalryMatrix: { solvers: topSolvers, matrix },
    avgProfitPerTradeUSDC,
    sizeSegments,
    tradesPreview: filtered.slice(0, 200).map(t => ({
      orderUid: t.orderUid,
      timestamp: t.ts,
      direction: t.direction,
      notionalUSDC: t.notionalUSDC,
      participants: t.participants,
      winner: t.winner,
      winnerPriceUSDCPerBTC: null,
      secondBestPriceUSDCPerBTC: null,
      priceMarginPct: t.priceMarginPct,
      topSolutions: undefined,
    })),
  }
}


