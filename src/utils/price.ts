const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'.toLowerCase()
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'.toLowerCase()
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'.toLowerCase()

export const TOKEN_DECIMALS: Record<string, number> = {
  [USDC]: 6,
  [WBTC]: 8,
  [WETH]: 18,
}

export function normalizeAmount(raw: string, token: string): number {
  const decimals = TOKEN_DECIMALS[token.toLowerCase()] ?? 18
  return Number(raw) / 10 ** decimals
}

export function computePriceUSDCPerBase(
  sellToken: string,
  buyToken: string,
  sellAmountRaw: string,
  buyAmountRaw: string
): number | null {
  const s = sellToken.toLowerCase()
  const b = buyToken.toLowerCase()
  // USDC -> Base (WBTC/WETH)
  if (s === USDC && (b === WBTC || b === WETH)) {
    const usdc = normalizeAmount(sellAmountRaw, s)
    const btc = normalizeAmount(buyAmountRaw, b)
    if (btc === 0) return null
    return usdc / btc
  }
  // Base -> USDC
  if ((s === WBTC || s === WETH) && b === USDC) {
    const btc = normalizeAmount(sellAmountRaw, s)
    const usdc = normalizeAmount(buyAmountRaw, b)
    if (btc === 0) return null
    return usdc / btc
  }
  return null
}

export function higherPriceIsBetterUSDCPerBase(sellToken: string, buyToken: string): boolean | null {
  const s = sellToken.toLowerCase()
  const b = buyToken.toLowerCase()
  if ((s === WBTC || s === WETH) && b === USDC) return true
  if (s === USDC && (b === WBTC || b === WETH)) return false
  return null
}

export function blockMidUSDCPerBase(eventBlockPrices: Record<string, { high: number; low: number }>): number | null {
  // eventBlockPrices contains either BTC_USDC (~120k) or USDC_BTC (~0.000009)
  // We want USDC per BTC
  if (!eventBlockPrices) return null
  if (eventBlockPrices['BTC_USDC'] || eventBlockPrices['ETH_USDC']) {
    const p = eventBlockPrices['BTC_USDC']
      ?? eventBlockPrices['ETH_USDC']
    return (p.high + p.low) / 2
  }
  if (eventBlockPrices['USDC_BTC'] || eventBlockPrices['USDC_ETH']) {
    const p = eventBlockPrices['USDC_BTC']
      ?? eventBlockPrices['USDC_ETH']
    const mid = (p.high + p.low) / 2
    if (mid === 0) return null
    return 1 / mid
  }
  return null
}

export function blockHighUSDCPerBase(eventBlockPrices: Record<string, { high: number; low: number }>): number | null {
  if (!eventBlockPrices) return null
  if (eventBlockPrices['BTC_USDC'] || eventBlockPrices['ETH_USDC']) {
    // Already USDC per BTC
    const p = eventBlockPrices['BTC_USDC'] ?? eventBlockPrices['ETH_USDC']
    return p.high
  }
  if (eventBlockPrices['USDC_BTC'] || eventBlockPrices['USDC_ETH']) {
    const p = eventBlockPrices['USDC_BTC'] ?? eventBlockPrices['USDC_ETH']
    // For BTC per USDC, USDC per BTC high = 1 / (low BTC per USDC)
    if (p.low === 0) return null
    return 1 / p.low
  }
  return null
}

export function percentDiff(a: number, b: number): number | null {
  if (!isFinite(a) || !isFinite(b) || b === 0) return null
  return (a - b) / b
}

export function toDay(ts: number): string {
  const d = new Date(ts * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const da = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${da}`
}

export const TOKENS = { USDC, WBTC, WETH }


