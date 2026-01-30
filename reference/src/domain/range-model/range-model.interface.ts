import Decimal from 'decimal.js';
import { DynamicRangeResult, VolatilityRegime, RangeModelConfig, VolatilityDetails } from './range-model.types';

/**
 * Range Model Service Interface
 *
 * Calculates dynamic LP range width based on market volatility.
 * Uses realized volatility from OHLCV data to determine optimal range.
 *
 * Dependencies:
 * - ConfigService (lpRange config for min/max bounds)
 * - BinanceClient (for getVolatility)
 */
export interface IRangeModelService {
  /**
   * Calculate dynamic LP range width based on current volatility
   *
   * @returns DynamicRangeResult with recommended range and regime info
   */
  calculateDynamicRange(): Promise<DynamicRangeResult>;

  /**
   * Get current volatility regime
   *
   * @returns Current volatility regime classification
   */
  getCurrentRegime(): Promise<VolatilityRegime>;

  /**
   * Get 24h effective volatility (blended 1d + 3d)
   *
   * @returns Effective volatility as percentage (e.g., 3.5 = 3.5%)
   */
  getVolatility24h(): Promise<Decimal>;

  /**
   * Get full dual-window volatility details
   *
   * Returns both 1d and 3d volatility plus spike ratio and trend.
   * Useful for monitoring and debugging.
   *
   * @returns VolatilityDetails with all volatility metrics
   */
  getVolatilityDetails(): Promise<VolatilityDetails>;

  /**
   * Calculate expected price move for given hours (uses 1d vol)
   *
   * @param hours - Time horizon in hours
   * @returns Expected move as percentage
   */
  getExpectedMove(hours: number): Promise<Decimal>;

  /**
   * Check if LP should be disabled due to extreme volatility
   *
   * @returns True if LP should be disabled
   */
  shouldDisableLp(): Promise<boolean>;

  /**
   * Get current configuration
   */
  getConfig(): RangeModelConfig;

  /**
   * Update configuration (partial update)
   */
  updateConfig(patch: Partial<RangeModelConfig>): void;
}
