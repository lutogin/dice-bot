import Decimal from 'decimal.js';
import {
  DynamicThresholdInput,
  DynamicThresholdResult,
  DynamicThresholdConfig,
} from './dynamic-threshold.types';

/**
 * Dynamic Threshold Service Interface
 *
 * Calculates dynamic rehedge threshold based on:
 * 1. Position size (scale effect)
 * 2. Market volatility (regime)
 * 3. Execution cost (optional)
 * 4. Proximity to LP boundary (risk)
 *
 * Usage:
 *   - recalculate() is called on cron schedule
 *   - getThreshold() returns cached value for use in rehedge decisions
 */
export interface IDynamicThresholdService {
  /**
   * Check if dynamic threshold is enabled
   */
  isEnabled(): boolean;

  /**
   * Get current threshold value (cached)
   *
   * Returns the last calculated threshold, or static fallback if:
   * - Dynamic threshold is disabled
   * - No calculation has been done yet
   *
   * @returns Current threshold as Decimal (e.g., 0.05 = 5%)
   */
  getThreshold(): Decimal;

  /**
   * Get full cached result with all factors (for diagnostics/logging)
   */
  getLastResult(): DynamicThresholdResult | null;

  /**
   * Get time since last recalculation (ms)
   */
  getTimeSinceLastRecalculate(): number;

  /**
   * Recalculate threshold with new input data
   *
   * Should be called on cron schedule (e.g., every 5 min)
   * Updates the cached threshold value
   *
   * @param input - Current LP notional, volatility, boundary distance
   * @returns Updated threshold result
   */
  recalculate(input: DynamicThresholdInput): DynamicThresholdResult;

  /**
   * Calculate threshold without caching (for one-off calculations)
   *
   * @param input - LP notional, volatility, boundary distance, costs
   * @returns Threshold result (not cached)
   */
  calculateThreshold(input: DynamicThresholdInput): DynamicThresholdResult;

  /**
   * Check if rehedge should be skipped based on current cached threshold
   *
   * @param currentDeviation - Current hedge deviation as Decimal
   * @returns true if rehedge should be skipped (deviation <= threshold)
   */
  shouldSkipRehedge(currentDeviation: Decimal): boolean;

  /**
   * Get current configuration
   */
  getConfig(): DynamicThresholdConfig;

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<DynamicThresholdConfig>): void;
}
