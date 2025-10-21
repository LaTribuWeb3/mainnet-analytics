import type { CompetitionData, TradeDocument } from '../types'

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isCompetitionData(value: unknown): value is CompetitionData {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    isNumber(v.buyUsdcPrice) &&
    isNumber(v.sellUsdcPrice) &&
    isNumber(v.feeInUSD) &&
    isNumber(v.orderBuyValueUsd) &&
    isNumber(v.orderSellValueUsd) &&
    isNumber(v.rateDiffBps) &&
    isNumber(v.usdPnLExcludingFee)
  )
}

export function isTradeDocument(value: unknown): value is TradeDocument {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>

  const baseFieldsValid =
    isString(v._id) &&
    isString(v.orderUid) &&
    isString(v.txHash) &&
    isNumber(v.blockNumber) &&
    isNumber(v.blockTimestamp) &&
    isString(v.buyAmount) &&
    isString(v.buyToken) &&
    isString(v.owner) &&
    isString(v.sellAmount) &&
    isString(v.sellToken) &&
    isString(v.transactionFee)

  if (!baseFieldsValid) return false

  const comp = (v as { competitionData?: unknown }).competitionData
  if (comp === undefined || comp === null) return false
  return isCompetitionData(comp)
}


