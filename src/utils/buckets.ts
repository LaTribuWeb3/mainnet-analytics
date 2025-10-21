import type { TradeDocument } from '../types'

export interface TradeBuckets {
  b0_1k: TradeDocument[]
  b1k_5k: TradeDocument[]
  b5k_20k: TradeDocument[]
  b20k_50k: TradeDocument[]
  b50k_100k: TradeDocument[]
  b100k_500k: TradeDocument[]
  b500k_5m: TradeDocument[]
  b5m_plus: TradeDocument[]
}

export function splitTradesBySellValueUsd(trades: TradeDocument[]): TradeBuckets {
  const buckets: TradeBuckets = {
    b0_1k: [],
    b1k_5k: [],
    b5k_20k: [],
    b20k_50k: [],
    b50k_100k: [],
    b100k_500k: [],
    b500k_5m: [],
    b5m_plus: [],
  }

  for (const trade of trades) {
    const raw = trade.orderSellValueUsd as number | string | undefined
    const value = typeof raw === 'string' ? Number(raw) : raw
    if (value === undefined) continue
    if (!Number.isFinite(value)) continue

    if (value >= 0 && value < 1_000) {
      buckets.b0_1k.push(trade)
    } else if (value >= 1_000 && value < 5_000) {
      buckets.b1k_5k.push(trade)
    } else if (value >= 5_000 && value < 20_000) {
      buckets.b5k_20k.push(trade)
    } else if (value >= 20_000 && value < 50_000) {
      buckets.b20k_50k.push(trade)
    } else if (value >= 50_000 && value < 100_000) {
      buckets.b50k_100k.push(trade)
    } else if (value >= 100_000 && value < 500_000) {
      buckets.b100k_500k.push(trade)
    } else if (value >= 500_000 && value < 5_000_000) {
      buckets.b500k_5m.push(trade)
    } else if (value >= 5_000_000) {
      buckets.b5m_plus.push(trade)
    }
  }

  return buckets
}


