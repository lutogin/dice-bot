/**
 * Normalized trade tick from WebSocket stream
 */
export interface NormalizedTick {
  ts: number;
  symbol: string;
  price: number;
  qty: number;
  side: 'BUY' | 'SELL';
  tradeId: string;
  notionalUsdc: number;
}

/**
 * Order book snapshot
 */
export interface OrderBookSnap {
  ts: number;
  symbol: string;
  bids: [number, number][]; // [price, qty][]
  asks: [number, number][];
  midPrice: number;
  spread: number;
  spreadPct: number;
}

/**
 * Liquidation print from liquidation stream
 */
export interface LiqPrint {
  ts: number;
  symbol: string;
  side: 'LONG_LIQ' | 'SHORT_LIQ';
  price: number;
  qty: number;
  notionalUsdc: number;
}

/**
 * Open Interest data
 */
export interface OpenInterestData {
  ts: number;
  symbol: string;
  openInterest: number;
  openInterestUsdc: number;
}

/**
 * Funding rate data
 */
export interface FundingRateData {
  ts: number;
  symbol: string;
  rate: number;
  nextFundingTime: number;
}

/**
 * Aggregated market state for a symbol
 */
export interface MarketState {
  symbol: string;
  lastPrice: number;
  lastTick: NormalizedTick | null;
  lastBook: OrderBookSnap | null;
  lastLiq: LiqPrint | null;
  openInterest: OpenInterestData | null;
  fundingRate: FundingRateData | null;
  updatedAt: number;
}
