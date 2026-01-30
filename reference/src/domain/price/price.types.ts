import Decimal from 'decimal.js';

/**
 * Price source identifier
 */
export type PriceSource = 'cex' | 'dex' | 'aggregated';

/**
 * Price data with metadata
 */
export interface PriceData {
  /** The price value */
  price: Decimal;
  /** Source of the price */
  source: PriceSource;
  /** Timestamp when price was fetched */
  timestamp: number;
  /** Age of price in milliseconds */
  ageMs: number;
  /** Symbol/pair */
  symbol: string;
  /** Whether the price is considered stale */
  isStale: boolean;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * CEX price data with order book info
 */
export interface CexPriceData extends PriceData {
  source: 'cex';
  /** Bid price */
  bid?: Decimal;
  /** Ask price */
  ask?: Decimal;
  /** Spread in percent */
  spreadPercent?: Decimal;
  /** Mark price (for futures) */
  markPrice: Decimal;
  /** Index price */
  indexPrice?: Decimal;
  /** Last traded price */
  lastPrice?: Decimal;
  /** Exchange ID */
  exchangeId: string;
}

/**
 * DEX pool price data
 */
export interface DexPriceData extends PriceData {
  source: 'dex';
  /** Pool address */
  poolAddress: string;
  /** Current sqrtPriceX96 */
  sqrtPriceX96: bigint;
  /** Current tick */
  tick: number;
  /** Token0 address */
  token0: string;
  /** Token1 address */
  token1: string;
  /** Pool liquidity */
  liquidity?: bigint;
  /** Fee tier */
  feeTier: number;
  /** Price is token0/token1 (true) or token1/token0 (false) */
  isToken0Base: boolean;
}

/**
 * TWAP (Time-Weighted Average Price) data
 */
export interface TwapData {
  /** TWAP price */
  price: Decimal;
  /** Period in seconds */
  periodSeconds: number;
  /** Number of observations used */
  observationsUsed: number;
  /** Start tick */
  startTick: number;
  /** End tick */
  endTick: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * Reference price with confidence info
 */
export interface ReferencePrice {
  /** The reference price */
  price: Decimal;
  /** Confidence level (0-1) */
  confidence: Decimal;
  /** Sources used */
  sources: PriceSource[];
  /** Price deviation between sources (percent) */
  deviationPercent: Decimal;
  /** CEX price if available */
  cexPrice?: Decimal;
  /** DEX price if available */
  dexPrice?: Decimal;
  /** Whether prices are consistent */
  isConsistent: boolean;
  /** Timestamp */
  timestamp: number;
  /** Warning messages */
  warnings: string[];
}

/**
 * Price aggregation method
 */
export type AggregationMethod = 'median' | 'mean' | 'weighted' | 'cex_priority' | 'dex_priority';

/**
 * Price service configuration
 */
export interface PriceServiceConfig {
  /** Maximum price age before considered stale (ms) */
  maxPriceAgeMs: number;
  /** Maximum deviation between sources before warning (percent) */
  maxDeviationPercent: Decimal;
  /** Aggregation method */
  aggregationMethod: AggregationMethod;
  /** TWAP period in seconds */
  twapPeriodSeconds: number;
  /** Whether to use TWAP for DEX price */
  useTwap: boolean;
  /** Weight for CEX price in weighted average */
  cexWeight: Decimal;
  /** Weight for DEX price in weighted average */
  dexWeight: Decimal;
  /** Minimum sources required for confidence */
  minSourcesForHighConfidence: number;
}

/**
 * Price cache entry
 */
export interface PriceCacheEntry {
  cex?: CexPriceData;
  dex?: DexPriceData;
  twap?: TwapData;
  reference?: ReferencePrice;
  lastUpdate: number;
}

/**
 * Price fetch result
 */
export interface PriceFetchResult {
  success: boolean;
  data?: PriceData;
  error?: string;
  latencyMs: number;
}

/**
 * Price comparison result
 */
export interface PriceComparison {
  cexPrice?: Decimal;
  dexPrice?: Decimal;
  absoluteDiff: Decimal;
  percentDiff: Decimal;
  isWithinThreshold: boolean;
  preferredSource: PriceSource;
  timestamp: number;
}
