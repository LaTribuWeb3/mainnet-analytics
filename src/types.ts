export interface CompetitionData {
  buyUsdcPrice: number
  sellUsdcPrice: number
  feeInUSD: number
  orderBuyValueUsd: number
  orderSellValueUsd: number
  rateDiffBps: number
  usdPnLExcludingFee: number
}

export interface TradeDocument {
  _id: string
  orderUid: string
  txHash: string
  blockNumber: number
  blockTimestamp: number
  buyAmount: string
  buyToken: string
  owner: string
  sellAmount: string
  sellToken: string
  transactionFee: string
  competitionData?: CompetitionData
}

export interface TradesApiResponse {
  documents: TradeDocument[]
}


