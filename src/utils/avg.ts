/**
 * Average and aggregation helpers used across analytics tables.
 *
 * Key concepts:
 * - USDC per token (price): how many USDC for 1 unit of the non‑USDC token.
 * - Direction adjustment: depending on trade direction, a higher price can be
 *   better (selling token for USDC) or worse (buying token with USDC). We use
 *   `higherPriceIsBetterUSDCPerToken` to normalize signs so "positive = better
 *   for the trader" consistently.
 * - Percent delta: ((A − B) / B) × 100; null if denominator is 0 or values are not finite.
 * - Basis points (bps): 1% = 100 bps.
 */
import { TOKENS, computePriceUSDCPerToken, higherPriceIsBetterUSDCPerToken, normalizeAmount, isStableToken } from './price'

/**
 * Average Prycto vs Market delta (%) for WETH-side trades.
 *
 * For each doc where WETH participates, compute percent difference between
 * Prycto's USDC-per-token and the market price for the non‑USDC side.
 * Apply direction adjustment so positive means "better for the trader".
 *
 * - Skips docs with non-finite prices or 0 denominator
 * - Returns null if no eligible docs
 */
export function avgDeltaWethPrice(
  docs: { buyToken: string; sellToken: string; buyUsdcPrice: number; sellUsdcPrice: number; pryctoApiPrice?: number }[]
): number | null {
  const WETH = TOKENS.WETH
  let sumPct = 0
  let count = 0
  for (const d of docs) {
    // Only consider trades involving WETH
    const isWethBuy = (d.buyToken || '').toLowerCase() === WETH
    const isWethSell = (d.sellToken || '').toLowerCase() === WETH
    if (!isWethBuy && !isWethSell) continue
    // Market price (USDC-per-non‑USDC token)
    const market = isWethBuy ? d.buyUsdcPrice : d.sellUsdcPrice
    const prycto = (d as { pryctoApiPrice?: number }).pryctoApiPrice
    if (!Number.isFinite(market) || !Number.isFinite(prycto) || market === 0) continue
    const rawPct = (((prycto as number) - (market as number)) / (market as number)) * 100
    const dir = higherPriceIsBetterUSDCPerToken(d.sellToken, d.buyToken)
    if (dir === null) continue
    // Normalize sign so positive implies improvement for the trader
    const adjustedPct = rawPct * (dir ? 1 : -1)
    sumPct += adjustedPct
    count += 1
  }
  if (count === 0) return null
  return sumPct / count
}

/**
 * Average Prycto vs Execution delta (%).
 *
 * Execution price is computed from on-chain amounts via `computePriceUSDCPerToken`.
 * We compare Prycto to Execution as a percentage and direction-adjust the sign.
 */
export function avgDeltaVsExecutionPct(
  docs: { buyToken: string; sellToken: string; sellAmount: string; buyAmount: string; pryctoApiPrice?: number }[]
): number | null {
  let sumPct = 0
  let count = 0
  for (const d of docs) {
    // Execution price from normalized amounts
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

/**
 * Average winning-bid vs Market delta (%).
 *
 * For docs with competition data, locate the winning bid, compute its USDC-
 * per-token price, compare to the relevant market price, direction-adjust, and average.
 */
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
    const isSellStable = isStableToken(d.sellToken)
    const isBuyStable = isStableToken(d.buyToken)
    let market: number | null = null
    if (isSellStable) market = d.buyUsdcPrice
    else if (isBuyStable) market = d.sellUsdcPrice
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

/**
 * Average Execution vs Market delta (%).
 *
 * Compute execution price from amounts, compare to market, apply direction
 * sign, then average.
 */
export function avgDeltaExecVsMarketPct(
  docs: { buyToken: string; sellToken: string; sellAmount: string; buyAmount: string; buyUsdcPrice: number; sellUsdcPrice: number }[]
): number | null {
  let sumPct = 0
  let count = 0
  for (const d of docs) {
    const exec = computePriceUSDCPerToken(d.sellToken, d.buyToken, d.sellAmount, d.buyAmount)
    if (!Number.isFinite(exec) || (exec as number) === 0) continue
    const isSellStable = isStableToken(d.sellToken)
    const isBuyStable = isStableToken(d.buyToken)
    let market: number | null = null
    if (isSellStable) market = d.buyUsdcPrice
    else if (isBuyStable) market = d.sellUsdcPrice
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

/**
 * Average Execution premium (bps) vs Market.
 *
 * Uses the same inputs and direction-adjustment as `avgDeltaExecVsMarketPct`,
 * but returns basis points: ((exec − market) / market) × 10,000, adjusted so
 * positive consistently means "better for the trader".
 */
export function avgExecPremiumBps(
  docs: { buyToken: string; sellToken: string; sellAmount: string; buyAmount: string; buyUsdcPrice: number; sellUsdcPrice: number }[]
): number | null {
  let sumBps = 0
  let count = 0
  for (const d of docs) {
    const exec = computePriceUSDCPerToken(d.sellToken, d.buyToken, d.sellAmount, d.buyAmount)
    if (!Number.isFinite(exec) || (exec as number) === 0) continue
    const isSellStable = isStableToken(d.sellToken)
    const isBuyStable = isStableToken(d.buyToken)
    let market: number | null = null
    if (isSellStable) market = d.buyUsdcPrice
    else if (isBuyStable) market = d.sellUsdcPrice
    if (!Number.isFinite(market) || (market as number) === 0) continue
    const rawBps = (((exec as number) - (market as number)) / (market as number)) * 10000
    const dir = higherPriceIsBetterUSDCPerToken(d.sellToken, d.buyToken)
    if (dir === null) continue
    const adjustedBps = rawBps * (dir ? 1 : -1)
    sumBps += adjustedBps
    count += 1
  }
  if (count === 0) return null
  return sumBps / count
}

/**
 * Average Prycto bid premium (bps) vs Market for docs where Prycto placed a bid.
 *
 * For each document, locate a Prycto bid (by address), compute its implied
 * USDC-per-token price using bid amounts, compare to the market price relevant
 * to the USDC side, apply direction-adjustment so positive means better for the
 * trader, and average the result in basis points.
 */
export function avgPryctoBidPremiumBps(
  docs: {
    buyToken: string
    sellToken: string
    buyUsdcPrice: number
    sellUsdcPrice: number
    competitionData?: { bidData?: { sellAmount: string; buyAmount: string; solverAddress?: string }[] }
  }[],
  pryctoAddress: string
): number | null {
  const addrLc = (pryctoAddress || '').toLowerCase()
  let sumBps = 0
  let count = 0
  for (const d of docs) {
    const bids = d.competitionData?.bidData || []
    const pBid = bids.find((b) => (b?.solverAddress || '').toLowerCase() === addrLc)
    if (!pBid) continue
    const pryctoPrice = computePriceUSDCPerToken(d.sellToken, d.buyToken, pBid.sellAmount, pBid.buyAmount)
    if (!Number.isFinite(pryctoPrice) || (pryctoPrice as number) === 0) continue
    const isSellUSDC = (d.sellToken || '').toLowerCase() === TOKENS.USDC
    const isBuyUSDC = (d.buyToken || '').toLowerCase() === TOKENS.USDC
    let market: number | null = null
    if (isSellUSDC) market = d.buyUsdcPrice
    else if (isBuyUSDC) market = d.sellUsdcPrice
    if (!Number.isFinite(market) || (market as number) === 0) continue
    const rawBps = (((pryctoPrice as number) - (market as number)) / (market as number)) * 10000
    const dir = higherPriceIsBetterUSDCPerToken(d.sellToken, d.buyToken)
    if (dir === null) continue
    const adjustedBps = rawBps * (dir ? 1 : -1)
    sumBps += adjustedBps
    count += 1
  }
  if (count === 0) return null
  return sumBps / count
}

/**
 * Average of Prycto bid buyAmount over winning bid buyAmount (normalized units).
 *
 * Only considers documents where a winner exists and Prycto also bid. Skips
 * entries with non-finite amounts or zero denominators. Returns null if no
 * eligible entries.
 */
export function avgPryctoBidBuyOverWinnerBuy(
  docs: {
    buyToken: string
    competitionData?: { bidData?: { winner?: boolean; buyAmount: string; solverAddress?: string }[] }
  }[],
  pryctoAddress: string
): number | null {
  const addrLc = (pryctoAddress || '').toLowerCase()
  const ratios: number[] = []
  let sum = 0
  let count = 0
  for (const d of docs) {
    const bids = d.competitionData?.bidData || []
    const winner = bids.find((b) => b?.winner === true)
    if (!winner) continue
    const pryctoBid = bids.find((b) => (b?.solverAddress || '').toLowerCase() === addrLc)
    if (!pryctoBid) continue
    const pryctoBuy = normalizeAmount(pryctoBid.buyAmount, d.buyToken)
    const winnerBuy = normalizeAmount(winner.buyAmount, d.buyToken)
    if (!Number.isFinite(pryctoBuy) || !Number.isFinite(winnerBuy) || winnerBuy === 0) continue
    const ratio = (pryctoBuy as number) / (winnerBuy as number)
    ratios.push(ratio)
    sum += ratio
    count += 1
  }
  if (ratios.length > 0) console.log('Prycto buyAmount / Winner buyAmount ratios (normalized):', ratios)
  if (count === 0) return null
  return sum / count
}

/**
 * Average Prycto vs Market premium (bps) for WETH-side trades.
 *
 * Same as `avgDeltaWethPrice` but scaled to basis points and averaged.
 */
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

/**
 * Simple average of `rateDiffBps` across an array.
 * - Parses string values
 * - Ignores non-finite entries
 * - Returns null if no valid values
 */
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

/**
 * Direction-adjusted average of `rateDiffBps`.
 *
 * Uses `higherPriceIsBetterUSDCPerToken` to flip sign where needed so that
 * positive consistently means "better for the trader".
 */
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

/**
 * Average PnL pair: returns averages excluding fees and including fees.
 *
 * - Parses string inputs
 * - Ignores rows with non-finite values
 * - `inc` = PnL excluding fee − fee
 */
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


