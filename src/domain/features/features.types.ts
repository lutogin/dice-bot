/**
 * Computed features for signal generation
 */
export interface Features {
  ts: number;
  symbol: string;

  // Current price
  px: number;

  // Price returns
  ret5s: number;
  ret30s: number;
  ret1m: number;

  // Volatility
  rv30s: number; // realized vol 30s (std dev of log returns)
  rv1m: number;

  // Liquidation metrics
  liqNotional30s: number;
  liqCount30s: number;
  liqNotional1m: number;

  // Volume metrics
  buyNotional30s: number;
  sellNotional30s: number;
  cvd30s: number; // cumulative volume delta (buy - sell)
  cvd1m: number;

  // Book metrics
  bookImbalance: number; // (bidQty - askQty) / (bidQty + askQty) for top N levels
  microprice: number; // weighted mid price based on book imbalance
  spread: number;
  spreadPct: number;

  // Absorption/replenish metrics (for stall detection)
  stallRangePct10s: number; // (high - low) / mid over last 10s
  bookReplenishScore10s: number; // how quickly book refills after hit

  // Context metrics
  openInterest: number;
  fundingRate: number;
}

/**
 * Rolling window data for feature calculation
 */
export interface RollingWindow {
  symbol: string;

  // Price history
  prices1s: { ts: number; price: number }[];
  prices5s: { ts: number; price: number }[];

  // Trade history
  trades30s: {
    ts: number;
    price: number;
    qty: number;
    side: 'BUY' | 'SELL';
    notional: number;
  }[];
  trades1m: {
    ts: number;
    price: number;
    qty: number;
    side: 'BUY' | 'SELL';
    notional: number;
  }[];

  // Liquidation history
  liqs30s: { ts: number; notional: number; side: 'LONG_LIQ' | 'SHORT_LIQ' }[];
  liqs1m: { ts: number; notional: number; side: 'LONG_LIQ' | 'SHORT_LIQ' }[];
  liqs1h: { ts: number; notional: number; side: 'LONG_LIQ' | 'SHORT_LIQ' }[];

  // Book history for replenish calculation
  bookSnapshots10s: { ts: number; topBidQty: number; topAskQty: number }[];

  // Stall detection
  priceRange10s: { high: number; low: number; mid: number };
}

/**
 * Median/percentile cache for comparison
 */
export interface FeatureBaselines {
  symbol: string;

  // Liquidation baselines (1h rolling)
  medianLiqNotional30s1h: number;
  p90LiqNotional30s1h: number;

  // Volatility baselines (24h rolling)
  medianRv30s24h: number;
  p90Rv30s24h: number;

  updatedAt: number;
}
