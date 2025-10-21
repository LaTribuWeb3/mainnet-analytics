import type { CompetitionData, TradeDocument } from '../types'

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined
}

export function isCompetitionData(value: unknown): value is CompetitionData {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    hasValue(v.buyUsdcPrice) &&
    hasValue(v.sellUsdcPrice) &&
    hasValue(v.feeInUSD) &&
    hasValue(v.orderBuyValueUsd) &&
    hasValue(v.orderSellValueUsd) &&
    hasValue(v.rateDiffBps) &&
    hasValue(v.usdPnLExcludingFee)
  )
}

export function isTradeDocument(value: unknown): value is TradeDocument {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>

  const baseFieldsPresent =
    hasValue(v._id) &&
    hasValue(v.orderUid) &&
    hasValue(v.txHash) &&
    hasValue(v.blockNumber) &&
    hasValue(v.blockTimestamp) &&
    hasValue(v.buyAmount) &&
    hasValue(v.buyToken) &&
    hasValue(v.owner) &&
    hasValue(v.sellAmount) &&
    hasValue(v.sellToken) &&
    hasValue(v.transactionFee)

  if (!baseFieldsPresent) return false

  const comp = (v as { competitionData?: unknown }).competitionData
  if (comp === undefined || comp === null) return true
  return isCompetitionData(comp)
}

export const REQUIRED_TRADE_FIELDS = [
  '_id',
  'orderUid',
  'txHash',
  'blockNumber',
  'blockTimestamp',
  'buyAmount',
  'buyToken',
  'owner',
  'sellAmount',
  'sellToken',
  'transactionFee',
] as const

export const REQUIRED_COMPETITION_FIELDS = [
  'buyUsdcPrice',
  'sellUsdcPrice',
  'feeInUSD',
  'orderBuyValueUsd',
  'orderSellValueUsd',
  'rateDiffBps',
  'usdPnLExcludingFee',
] as const

export function getMissingTradeFields(value: unknown): string[] {
  if (value === null || typeof value !== 'object') {
    return [...REQUIRED_TRADE_FIELDS]
  }
  const v = value as Record<string, unknown>
  const missing: string[] = []

  for (const field of REQUIRED_TRADE_FIELDS) {
    if (!hasValue(v[field])) missing.push(field)
  }

  const comp = (v as { competitionData?: unknown }).competitionData as
    | Record<string, unknown>
    | null
    | undefined

  if (comp !== null && comp !== undefined) {
    for (const field of REQUIRED_COMPETITION_FIELDS) {
      if (!hasValue(comp[field])) missing.push(`competitionData.${field}`)
    }
  }

  return missing
}


