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
  cowswapFeeAmount: bigint;
  competitionData?: CompetitionData
  pryctoApiPrice?: number
  binancePrices?: BinancePrices
}
export type BinancePrices = {
  sellTokenInUSD: number;
  buyTokenInUSD: number;
}
export interface TradesApiResponse {
  documents: TradeDocument[]
}


