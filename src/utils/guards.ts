import type { CompetitionData, TradeDocument } from '../types'

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined
}

export function isCompetitionData(value: unknown): value is CompetitionData {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const bids = (v as { bidData?: unknown }).bidData
  return Array.isArray(bids)
}

export function isTradeDocument(value: unknown): value is TradeDocument {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>

  const hasTx = hasValue(v.txHash) || hasValue(v.transactionHash)

  const baseFieldsPresent =
    hasValue(v._id) &&
    hasValue(v.orderUid) &&
    hasTx &&
    hasValue(v.blockNumber) &&
    hasValue(v.blockTimestamp) &&
    hasValue(v.buyAmount) &&
    hasValue(v.buyToken) &&
    hasValue(v.owner) &&
    hasValue(v.sellAmount) &&
    hasValue(v.sellToken)

  if (!baseFieldsPresent) return false
  return true
}

export const REQUIRED_TRADE_FIELDS = [
  '_id',
  'orderUid',
  'txHash|transactionHash',
  'blockNumber',
  'blockTimestamp',
  'buyAmount',
  'buyToken',
  'owner',
  'sellAmount',
  'sellToken',
] as const

export const REQUIRED_COMPETITION_FIELDS = ['bidData'] as const

export function getMissingTradeFields(value: unknown): string[] {
  if (value === null || typeof value !== 'object') {
    return [...REQUIRED_TRADE_FIELDS]
  }
  const v = value as Record<string, unknown>
  const missing: string[] = []

  for (const field of REQUIRED_TRADE_FIELDS) {
    if (field === 'txHash|transactionHash') {
      if (!(hasValue(v['txHash']) || hasValue(v['transactionHash']))) missing.push('txHash')
      continue
    }
    if (!hasValue(v[field])) missing.push(field)
  }

  const comp = (v as { competitionData?: unknown }).competitionData as
    | Record<string, unknown>
    | null
    | undefined

  if (comp !== null && comp !== undefined) {
    for (const field of REQUIRED_COMPETITION_FIELDS) {
      if (!hasValue((comp as Record<string, unknown>)[field])) missing.push(`competitionData.${field}`)
    }
  }

  return missing
}


