import Decimal from 'decimal.js';

/**
 * Volatility regime classification
 */
export enum VolatilityRegime {
  /** < 1.5% 24h vol - Ultra calm market */
  ULTRA_CALM = 'ULTRA_CALM',
  /** 1.5-3% 24h vol - Calm market */
  CALM = 'CALM',
  /** 3-5% 24h vol - Normal market */
  NORMAL = 'NORMAL',
  /** 5-8% 24h vol - Volatile market */
  VOLATILE = 'VOLATILE',
  /** > 8% 24h vol - Chaos / extreme volatility */
  CHAOS = 'CHAOS',
}

/**
 * Volatility thresholds for regime classification (in percent, 24h annualized)
 */
export interface VolatilityThresholds {
  /** Threshold for ULTRA_CALM -> CALM */
  ultraCalmMax: number;
  /** Threshold for CALM -> NORMAL */
  calmMax: number;
  /** Threshold for NORMAL -> VOLATILE */
  normalMax: number;
  /** Threshold for VOLATILE -> CHAOS */
  volatileMax: number;
}

/**
 * Default volatility thresholds (in 24h percent)
 */
export const DEFAULT_VOLATILITY_THRESHOLDS: VolatilityThresholds = {
  ultraCalmMax: 1.5,   // < 1.5% = ultra calm
  calmMax: 3.0,        // 1.5-3% = calm
  normalMax: 5.0,      // 3-5% = normal
  volatileMax: 8.0,    // 5-8% = volatile, > 8% = chaos
};

/**
 * Range width mapping for each volatility regime (in percent ±)
 */
export interface RegimeRangeMapping {
  [VolatilityRegime.ULTRA_CALM]: { min: number; max: number };
  [VolatilityRegime.CALM]: { min: number; max: number };
  [VolatilityRegime.NORMAL]: { min: number; max: number };
  [VolatilityRegime.VOLATILE]: { min: number; max: number };
  [VolatilityRegime.CHAOS]: { min: number; max: number };
}

/**
 * Default range mapping based on volatility regime
 * APR grows sharply up to ~5-6% range, then risk grows faster than income
 */
export const DEFAULT_REGIME_RANGE_MAPPING: RegimeRangeMapping = {
  [VolatilityRegime.ULTRA_CALM]: { min: 3, max: 4 },
  [VolatilityRegime.CALM]: { min: 5, max: 6 },
  [VolatilityRegime.NORMAL]: { min: 7, max: 10 },
  [VolatilityRegime.VOLATILE]: { min: 12, max: 15 },
  [VolatilityRegime.CHAOS]: { min: 20, max: 25 }, // Very wide or LP off
};

/**
 * Range model configuration
 */
export interface RangeModelConfig {
  /** Symbol to track volatility for */
  symbol: string;
  /** Timeframe for volatility calculation */
  volatilityTimeframe: string;
  /** Number of candles for volatility calculation */
  volatilityCandleCount: number;
  /** Minimum allowed range width (percent) */
  minRangeWidthPercent: number;
  /** Maximum allowed range width (percent) */
  maxRangeWidthPercent: number;
  /** Volatility thresholds for regime classification */
  thresholds: VolatilityThresholds;
  /** Range mapping for each regime */
  regimeRanges: RegimeRangeMapping;
  /** Whether to disable LP in CHAOS regime */
  disableLpInChaos: boolean;
  /** Hours horizon for expected move calculation */
  horizonHours: number;
  // how many days of candles to use for volatility estimation
  volatilityWindowDays?: 1 | 3;
}

/**
 * Default range model configuration
 */
export const DEFAULT_RANGE_MODEL_CONFIG: RangeModelConfig = {
  symbol: 'ETH/USDT:USDT',
  volatilityTimeframe: '30m',
  volatilityCandleCount: 48,
  minRangeWidthPercent: 3,
  maxRangeWidthPercent: 25,
  thresholds: DEFAULT_VOLATILITY_THRESHOLDS,
  regimeRanges: DEFAULT_REGIME_RANGE_MAPPING,
  disableLpInChaos: false,
  horizonHours: 24,
  volatilityWindowDays: 1
};

/**
 * Volatility trend indicator
 */
export type VolatilityTrend = 'RISING' | 'FALLING' | 'STABLE';

/**
 * Dual-window volatility details (for external API)
 *
 * Exposes the internal volatility calculations for monitoring/debugging.
 */
export interface VolatilityDetails {
  /** Raw per-bar σ from 1d window */
  raw1d: Decimal;
  /** Raw per-bar σ from 3d window */
  raw3d: Decimal;
  /** 1d volatility annualized to 24h (%) */
  vol1d_24h: Decimal;
  /** 3d volatility annualized to 24h (%) */
  vol3d_24h: Decimal;
  /** Effective blended volatility (%) */
  effective: Decimal;
  /** Spike ratio: vol1d / vol3d */
  spikeRatio: Decimal;
  /** Trend based on spike ratio */
  trend: VolatilityTrend;
}

/**
 * Result of dynamic range calculation
 */
export interface DynamicRangeResult {
  /** Whether LP should be active in current conditions */
  lpEnabled: boolean;
  /** Calculated range width in percent (±) */
  rangeWidthPercent: Decimal;
  /** Current volatility regime */
  regime: VolatilityRegime;

  // ==================== Volatility Details ====================

  /** Effective volatility (blended 1d+3d) - used for regime & range */
  volatility24h: Decimal;
  /** 1-day volatility annualized to 24h (fast signal) */
  volatility1d: Decimal;
  /** 3-day volatility annualized to 24h (slow signal) */
  volatility3d: Decimal;
  /** Raw per-bar volatility (most recent, from 1d window) */
  rawVolatility: Decimal;

  // ==================== Diagnostics ====================

  /** Spike ratio: vol1d / vol3d (>1.5 = spike, <0.7 = drop) */
  spikeRatio: Decimal;
  /** Volatility trend based on spike ratio */
  volatilityTrend: VolatilityTrend;
  /** Expected move for horizon (based on 1d vol) */
  expectedMovePercent: Decimal;

  // ==================== Meta ====================

  /** Timestamp of calculation */
  calculatedAt: number;
  /** Reason for the range selection */
  reason: string;
}
