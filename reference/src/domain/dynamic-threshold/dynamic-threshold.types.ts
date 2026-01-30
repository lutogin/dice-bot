import Decimal from 'decimal.js';

/**
 * Input for dynamic threshold calculation
 */
export interface DynamicThresholdInput {
  /** Current LP position notional value in USDC */
  lpNotionalUsdc: Decimal;
  /** 24h volatility as decimal (e.g., 0.05 = 5%) */
  volatility24h: Decimal;
  /** Distance to nearest LP boundary as decimal (e.g., 0.05 = 5%) */
  distanceToBoundaryPct: Decimal;
  /** Whether LP is near boundary (within reset threshold) */
  isNearBoundary: boolean;
  /** Estimated hedge execution cost in USDC (spread + fees + impact) */
  estimatedHedgeCostUsdc?: Decimal;
  /** Estimated daily LP fees in USDC */
  lpDailyFeesUsdc?: Decimal;
  /** Current funding rate (8h) as decimal */
  fundingRate8h?: Decimal;
}

/**
 * Result of dynamic threshold calculation
 */
export interface DynamicThresholdResult {
  /** Final dynamic threshold as decimal (e.g., 0.05 = 5%) */
  threshold: Decimal;
  /** Base threshold before factors applied */
  baseThreshold: Decimal;
  /** Individual factors for debugging/logging */
  factors: ThresholdFactors;
  /** Raw threshold before clamping */
  rawThreshold: Decimal;
  /** Whether threshold was clamped */
  wasClamped: boolean;
  /** Calculation timestamp */
  timestamp: number;
}

/**
 * Individual factors contributing to dynamic threshold
 */
export interface ThresholdFactors {
  /** Size factor: sqrt(referenceNotional / lpNotional) */
  sizeFactor: Decimal;
  /** Volatility factor: clamp(vol24h / volRef, min, max) */
  volFactor: Decimal;
  /** Cost factor: 1 + (hedgeCost / lpDailyFees) */
  costFactor: Decimal;
  /** Boundary factor: kept for interface compatibility, always 1.0 (zone logic in RehedgeDecisionService) */
  boundaryFactor: Decimal;
}

/**
 * Configuration for dynamic threshold calculation
 */
export interface DynamicThresholdConfig {
  /** Enable dynamic threshold (false = use static STRATEGY_REHEDGE_THRESHOLD) */
  enabled?: boolean;
  /** Cron expression for recalculation schedule (default: every 30 min) */
  cronExpression?: string;
  /** Base threshold before applying factors (e.g., 0.05 = 5%) */
  baseThreshold: number;
  /** Reference LP notional for size factor calculation (e.g., 25000 USDC) */
  referenceNotionalUsdc: number;
  /** Reference volatility for vol factor (e.g., 0.04 = 4%) */
  referenceVolatility: number;
  /** Minimum volatility factor */
  volFactorMin: number;
  /** Maximum volatility factor */
  volFactorMax: number;
  /** Minimum final threshold (floor) */
  thresholdMin: number;
  /** Maximum final threshold (ceiling) */
  thresholdMax: number;
  /** Enable cost factor calculation */
  enableCostFactor: boolean;
  /** Maximum cost factor (cap) */
  costFactorMax: number;
  /** Estimated LP daily fees in USDC (for cost factor calculation) */
  lpDailyFeesEstimateUsdc: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_DYNAMIC_THRESHOLD_CONFIG: DynamicThresholdConfig = {
  enabled: false, // Disabled by default, uses static STRATEGY_REHEDGE_THRESHOLD
  cronExpression: '*/30 * * * *', // Every 30 minutes
  baseThreshold: 0.05, // 5%
  referenceNotionalUsdc: 25000, // $25k
  referenceVolatility: 0.04, // 4%
  volFactorMin: 0.8,
  volFactorMax: 1.3,
  thresholdMin: 0.03, // 3% floor
  thresholdMax: 0.08, // 8% ceiling
  enableCostFactor: false, // Disabled by default, requires fee estimation
  costFactorMax: 2.0,
  lpDailyFeesEstimateUsdc: 5, // $5/day default estimate
};
