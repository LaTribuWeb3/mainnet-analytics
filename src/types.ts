export interface BidDatum {
  buyAmount: string
  sellAmount: string
  solverAddress: string
  winner: boolean
}

export interface CompetitionData {
  bidData: BidDatum[]
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
  buyUsdcPrice: number
  sellUsdcPrice: number
  feeInUSD: number
  orderBuyValueUsd: number
  orderSellValueUsd: number
  rateDiffBps: number
  usdPnLExcludingFee: number
  competitionData?: CompetitionData
}

export interface TradesApiResponse {
  documents: TradeDocument[]
}


