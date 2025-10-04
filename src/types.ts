export interface CompetitionOrderQuote {
  id: string
  sellAmount: string
  buyAmount: string
  buyToken: string
  sellToken: string
}

export interface CompetitionSolution {
  solverAddress: string
  score: string
  ranking: number
  isWinner: boolean
  txHash: string | null
  referenceScore: string | null
  order: CompetitionOrderQuote
}

export type PriceBounds = Record<string, { high: number; low: number }>

export interface TradeRecord {
  orderUid: string
  sellToken: string
  buyToken: string
  sellAmount: string
  buyAmount: string
  eventBlockNumber: number
  eventBlockTimestamp: number
  eventTxHash: string
  txFeeWei: string
  competitionSolutions: CompetitionSolution[]
  eventBlockPrices: PriceBounds
}

export interface SolverStats {
  solverAddress: string
  wins: number
  tradesParticipated: number
  volumeUSDC: number
}

export interface DailySeriesPoint {
  day: string // YYYY-MM-DD
  trades: number
  avgParticipants: number
}

export interface AggregatesResult {
  totalTrades: number
  totalNotionalUSDC: number
  avgParticipants: number
  singleBidShare: number
  marginHistogram: Array<{ bucket: string; count: number }>
  participationHistogram: Array<{ bucket: string; count: number }>
  dailySeries: DailySeriesPoint[]
  solverStats: SolverStats[]
  rivalryMatrix?: {
    solvers: string[]
    matrix: number[][] // win rate of row vs col when both participate
  }
  topSolverAnalytics?: Array<{
    solverAddress: string
    wins: number
    tradesParticipated: number
    winRate: number
    volumeUSDC: number
    avgWinMarginPct: number | null
    p50WinMarginPct: number | null
  }>
  tradesPreview: Array<{
    orderUid: string
    timestamp: number
    direction: 'USDC_to_WBTC' | 'WBTC_to_USDC'
    notionalUSDC: number
    participants: number
    winner: string
    winnerPriceUSDCPerBTC: number | null
    secondBestPriceUSDCPerBTC: number | null
    priceMarginPct: number | null
    topSolutions?: Array<{ solver: string; priceUSDCPerBTC: number | null; rank: number }>
  }>
  // summaries for readability
  participationStats?: { count: number; min: number; p25: number; p50: number; p75: number; max: number; avg: number }
  marginStats?: { count: number; minPct: number; p25Pct: number; p50Pct: number; p75Pct: number; maxPct: number; avgPct: number }
}


