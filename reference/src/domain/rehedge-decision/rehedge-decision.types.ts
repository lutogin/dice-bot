import Decimal from 'decimal.js';

/**
 * Zone position within LP range
 *
 * |------|------|------|
 *    L       M       U
 *
 * L = Lower zone (near lower boundary)
 * M = Middle zone (center, safe)
 * U = Upper zone (near upper boundary)
 */
export type ZonePosition = 'lower' | 'middle' | 'upper';

/**
 * Rehedge mode based on zone and conditions
 */
export type RehedgeMode =
  | 'none' // No rehedge needed
  | 'normal' // Standard rehedge (delta drift exceeded)
  | 'protective' // Aggressive rehedge near boundary
  | 'gap_soft' // Hedge gap exceeded soft threshold (respects cooldown and price anomaly)
  | 'gap_hard'; // Hedge gap exceeded hard threshold (bypasses cooldown and price anomaly)

/**
 * Hysteresis state for rehedge decision
 *
 * STABLE: System is in equilibrium, waiting for drift to exceed ENTER threshold
 * ADJUSTED: Recently rehedged, waiting for drift to fall below EXIT threshold
 *
 * This prevents oscillation (churn) when drift hovers around threshold.
 */
export type HysteresisState = 'STABLE' | 'ADJUSTED';

/**
 * Input for rehedge decision
 */
export interface RehedgeDecisionInput {
  /** Current WETH amount in LP */
  currentWethAmount: Decimal;
  /** Current short position in USDC */
  currentShortUsdc: Decimal;
  /** Target short position in USDC */
  targetShortUsdc: Decimal;
  /** Reference ETH price */
  referencePrice: Decimal;
  /** Current price (for zone calculation) */
  spotPrice: Decimal;
  /** Lower bound of LP range */
  priceLower: Decimal;
  /** Upper bound of LP range */
  priceUpper: Decimal;
}

/**
 * Result of rehedge decision
 */
export interface RehedgeDecisionResult {
  /** Whether rehedge should be executed */
  shouldRehedge: boolean;
  /** Rehedge mode */
  mode: RehedgeMode;
  /** Zone position within LP range */
  zone: ZonePosition;
  /** Distance to nearest boundary as fraction (0.05 = 5%) */
  distanceToBoundary: Decimal;
  /** Delta drift since last hedge */
  deltaDrift: Decimal;
  /** Delta drift as percentage */
  deltaDriftPercent: Decimal;
  /** Effective threshold used (may be reduced near boundary) */
  effectiveThreshold: Decimal;
  /** Base threshold before zone adjustment */
  baseThreshold: Decimal;
  /** Threshold multiplier applied (1.0 = normal, 0.5 = protective) */
  thresholdMultiplier: Decimal;
  /** Direction of rehedge if needed */
  direction: 'increase' | 'decrease' | 'none';
  /** Reason if rehedge is skipped */
  skipReason?: string;
  /** USDC value of the drift */
  driftUsdc: Decimal;
  /** Whether minimum notional is met */
  minNotionalMet: boolean;

  // Hysteresis fields
  /** Current hysteresis state */
  hysteresisState: HysteresisState;
  /** Enter threshold (higher, for triggering rehedge from STABLE) */
  enterThreshold: Decimal;
  /** Exit threshold (lower, for returning to STABLE from ADJUSTED) */
  exitThreshold: Decimal;

  // Hedge gap safety fields
  /** Hedge gap as percentage (|current - target| / target) */
  hedgeGapPercent: Decimal;
  /** Hedge gap trigger level: none, soft, hard */
  hedgeGapTrigger: 'none' | 'soft' | 'hard';
}

/**
 * Configuration for rehedge decision service
 */
export interface RehedgeDecisionConfig {
  /** Minimum rehedge amount in USDC */
  minRehedgeAmountUsdc: Decimal;
  /** Static rehedge threshold (fallback) */
  staticThreshold: Decimal;

  // Zone configuration
  /** Fraction of range considered "near boundary" (e.g., 0.15 = 15%) */
  boundaryZoneWidth: number;
  /** Threshold multiplier when in protective zone (e.g., 0.5 = half threshold) */
  protectiveThresholdMultiplier: number;

  // Hysteresis configuration
  /**
   * Hysteresis factor for enter threshold (e.g., 1.3 = 30% higher than base)
   * ENTER_THRESHOLD = baseThreshold * zoneMultiplier * hysteresisFactor
   * EXIT_THRESHOLD = baseThreshold * zoneMultiplier
   */
  hysteresisFactor: number;

  // EMA smoothing configuration
  /**
   * EMA time constant in minutes for LP delta smoothing (e.g., 15-30 min)
   * Time-based formula: alpha = 1 - exp(-dt / tau), where tau = emaWindowMinutes * 60s
   * Larger tau = more smoothing, slower response to changes
   * Works correctly regardless of sampling frequency
   */
  emaWindowMinutes: number;

  // Hedge gap safety triggers
  /**
   * Soft hedge gap threshold (e.g., 0.07 = 7%)
   * When gap exceeds this, rehedge is allowed but respects cooldown
   */
  hedgeGapSoft: number;
  /**
   * Hard hedge gap threshold (e.g., 0.12 = 12%)
   * When gap exceeds this, rehedge immediately (ignores drift/hysteresis)
   */
  hedgeGapHard: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_REHEDGE_DECISION_CONFIG: Partial<RehedgeDecisionConfig> = {
  boundaryZoneWidth: 0.15, // 15% of range on each side
  protectiveThresholdMultiplier: 0.5, // Half threshold near boundary
  hysteresisFactor: 1.3, // Enter at 30% higher threshold than exit
  emaWindowMinutes: 20, // 20 min time constant for EMA smoothing (tau)
  hedgeGapSoft: 0.07, // 7% gap triggers rehedge (with cooldown)
  hedgeGapHard: 0.12, // 12% gap forces immediate rehedge
};
