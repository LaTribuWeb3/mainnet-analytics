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
  // Optional market prices per token (USDC per token) provided by API
  buyUsdcPrice?: number
  sellUsdcPrice?: number
}

export interface SolverStats {
  solverAddress: string
  wins: number
  tradesParticipated: number
  volumeUSDC: number
  profitUSDCWithFees?: number
  profitUSDCNoFees?: number
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
  sizeHistogram?: Array<{ bucket: string; count: number }>
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
  // overall average profit per trade (controlled by includeFees in filters)
  avgProfitPerTradeUSDC?: number
  // overall average profit vs market (block mid) per trade
  avgProfitVsMarketPerTradeUSDC?: number
  profitStatsWithFees?: {
    count: number
    totalUSDC: number
    avgUSDC: number
    p25USDC: number
    p50USDC: number
    p75USDC: number
  }
  profitStatsNoFees?: {
    count: number
    totalUSDC: number
    avgUSDC: number
    p25USDC: number
    p50USDC: number
    p75USDC: number
  }
  sizeStats?: {
    count: number
    avgUSDC: number
    p25USDC: number
    p50USDC: number
    p75USDC: number
  }
  singleBidSizeHistogram?: Array<{ bucket: string; count: number }>
  singleBidStats?: {
    count: number
    avgUSDC: number
    p25USDC: number
    p50USDC: number
    p75USDC: number
  }
  singleBidSolverLeaderboard?: Array<{
    solverAddress: string
    singleBidWins: number
    singleBidVolumeUSDC: number
  }>
  // segmented analytics by notional USDC size bucket
  sizeSegments?: Array<{
    bucket: string
    count: number
    volumeUSDC: number
    avgParticipants: number
    avgProfitPerTradeUSDC: number
    avgProfitVsMarketPerTradeUSDC: number
    topByProfit: Array<{ solverAddress: string; totalProfitUSDC: number }>
    topByWinRate: Array<{ solverAddress: string; winRate: number; tradesParticipated: number; wins: number }>
    topByVolume: Array<{ solverAddress: string; volumeUSDC: number; wins: number }>
    // if a solver filter is applied, capturedVolumeUSDC is the volume won by that solver in this bucket
    capturedVolumeUSDC?: number
    // if a solver filter is applied, per-bucket rank distribution and average loss delta vs winner
    rankHistogram?: Array<{ rank: number; count: number }>
    lossDeltaAvg?: number
    lossDeltaBpsAvg?: number
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
  // if a solver filter is applied, capturedVolumeUSDC is the total volume won by that solver
  capturedVolumeUSDC?: number
}


