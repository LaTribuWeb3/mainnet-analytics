import { TOKENS, computePriceUSDCPerToken, higherPriceIsBetterUSDCPerToken } from './price'

export function avgDeltaWethPrice(
  docs: { buyToken: string; sellToken: string; buyUsdcPrice: number; sellUsdcPrice: number; pryctoApiPrice?: number }[]
): number | null {
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

export function avgDeltaVsExecutionPct(
  docs: { buyToken: string; sellToken: string; sellAmount: string; buyAmount: string; pryctoApiPrice?: number }[]
): number | null {
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

export function avgDeltaWinnerVsMarketPct(
  docs: { buyToken: string; sellToken: string; buyUsdcPrice: number; sellUsdcPrice: number; competitionData?: { bidData?: { winner?: boolean; sellAmount: string; buyAmount: string }[] } }[]
): number | null {
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

export function avgDeltaExecVsMarketPct(
  docs: { buyToken: string; sellToken: string; sellAmount: string; buyAmount: string; buyUsdcPrice: number; sellUsdcPrice: number }[]
): number | null {
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

export function avgPryctoPremiumBps(
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

export function avgRateDiffBps(arr: { rateDiffBps: number | string }[]): number | null {
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

export function avgRateDiffBpsDirectionAdjusted(
  arr: { rateDiffBps: number | string; sellToken: string; buyToken: string }[]
): number | null {
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

export function avgProfitPair(
  arr: { usdPnLExcludingFee: number | string; feeInUSD: number | string }[]
): { ex: number | null; inc: number | null } {
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


