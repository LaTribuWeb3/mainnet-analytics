import type { TradeDocument, BidDatum } from '../types'
import { normalizeAmount } from './price'
import { SOLVERS_LC } from './solvers'

const PRYCTO_LABEL = 'Prycto'

function findPryctoBids(doc: TradeDocument): BidDatum[] {
  const bids = doc.competitionData?.bidData || []
  return bids.filter((b) => SOLVERS_LC[b.solverAddress?.toLowerCase?.() || ''] === PRYCTO_LABEL)
}

type MaybeExtended = TradeDocument & { sellUsdcPrice?: number; buyUsdcPrice?: number }

function impliedUsdcPerSellTokenFromBid(doc: TradeDocument, bid: BidDatum): number | null {
  const sellQty = normalizeAmount(bid.sellAmount, doc.sellToken)
  const buyQty = normalizeAmount(bid.buyAmount, doc.buyToken)
  if (!isFinite(sellQty) || !isFinite(buyQty) || sellQty === 0) return null
  // USDC per sell token implied by this bid:
  // (USDC per buy token) * (buy tokens per sell token)
  // = doc.buyUsdcPrice * (buyQty / sellQty)
  const buyUsdc = (doc as MaybeExtended).buyUsdcPrice ?? (doc.binancePrices?.buyTokenInUSD as number | undefined)
  if (!isFinite(buyUsdc as number)) return null
  const usdcPerSell = (buyUsdc as number) * (buyQty / sellQty)
  return isFinite(usdcPerSell) ? usdcPerSell : null
}

export function computeSellTokenPricesUSDC(doc: TradeDocument): { market: number | null; prycto: number | null } {
  const marketRaw = (doc as MaybeExtended).sellUsdcPrice ?? (doc.binancePrices?.sellTokenInUSD as number | undefined)
  const market = isFinite(marketRaw as number) ? (marketRaw as number) : null

  const pryctoBids = findPryctoBids(doc)
  if (pryctoBids.length === 0) return { market, prycto: null }

  // For scaffold: take the first Prycto bid's implied price. Later we might choose best/median.
  const first = pryctoBids[0]
  const prycto = impliedUsdcPerSellTokenFromBid(doc, first)

  console.log('orderID', doc.orderUid);
  console.log('market', market);
  console.log('prycto', prycto);

  return { market, prycto }
}


