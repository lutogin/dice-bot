import {
  RehedgeDecisionInput,
  RehedgeDecisionResult,
  ZonePosition,
} from './rehedge-decision.types';
import Decimal from 'decimal.js';

/**
 * Rehedge Decision Service Interface
 *
 * Responsible for deciding when and how to rehedge based on:
 * 1. LP Delta Drift (primary trigger) - accumulated position change since last hedge
 * 2. Zone-based protection (secondary trigger) - aggressive hedging near LP boundaries
 * 3. Hysteresis (anti-churn) - two thresholds to prevent oscillation
 *
 * HYSTERESIS LOGIC:
 * - STABLE state: trigger rehedge only when drift > ENTER_THRESHOLD (higher)
 * - ADJUSTED state: ignore rehedge until drift < EXIT_THRESHOLD (lower)
 * - This prevents churn when drift hovers around threshold
 *
 * Example with hysteresisFactor=1.3, baseThreshold=5%:
 * - ENTER_THRESHOLD = 6.5%
 * - EXIT_THRESHOLD = 5.0%
 * - Without hysteresis: 5.1→rehedge, 4.9→no, 5.2→rehedge (churn!)
 * - With hysteresis: 5.1→ignore, 6.6→rehedge, 6.1→ignore, 4.9→exit (1 rehedge)
 *
 * Dual-trigger logic:
 * - Primary mode (90% of time): Rehedge only if deltaDrift > threshold
 * - Protective mode (near boundary): Use threshold * 0.5 for more aggressive protection
 */
export interface IRehedgeDecisionService {
  /**
   * Evaluate whether rehedge should be executed
   *
   * Logic:
   * 1. Get current hysteresis state (STABLE/ADJUSTED)
   * 2. Calculate delta drift since last hedge
   * 3. Determine zone position (lower/middle/upper)
   * 4. Apply zone-based threshold adjustment
   * 5. Calculate ENTER and EXIT thresholds with hysteresis factor
   * 6. In STABLE: trigger if drift > ENTER_THRESHOLD
   * 7. In ADJUSTED: transition to STABLE if drift < EXIT_THRESHOLD
   * 8. Verify minimum notional is met
   *
   * @param input - Current position and price data
   * @returns Decision result with details including hysteresis state
   */
  evaluate(input: RehedgeDecisionInput): RehedgeDecisionResult;

  /**
   * Calculate zone position within LP range
   *
   * @param spotPrice - Current spot price
   * @param priceLower - Lower bound of LP range
   * @param priceUpper - Upper bound of LP range
   * @returns Zone position (lower/middle/upper)
   */
  getZonePosition(
    spotPrice: Decimal,
    priceLower: Decimal,
    priceUpper: Decimal,
  ): ZonePosition;

  /**
   * Calculate distance to nearest boundary as fraction
   *
   * @param spotPrice - Current spot price
   * @param priceLower - Lower bound of LP range
   * @param priceUpper - Upper bound of LP range
   * @returns Distance as fraction (0.05 = 5% of range)
   */
  getDistanceToBoundary(
    spotPrice: Decimal,
    priceLower: Decimal,
    priceUpper: Decimal,
  ): Decimal;

  /**
   * Get threshold multiplier based on zone position
   *
   * @param zone - Zone position
   * @param distanceToBoundary - Distance to nearest boundary
   * @returns Multiplier (1.0 = normal, 0.5 = protective)
   */
  getThresholdMultiplier(
    zone: ZonePosition,
    distanceToBoundary: Decimal,
  ): Decimal;

  /**
   * Get the WETH amount at last hedge (reference point)
   */
  getWethAtLastHedge(): Decimal | null;

  /**
   * Check if this is the first hedge (no reference point)
   */
  isFirstHedge(): boolean;
}

export const REHEDGE_DECISION_SERVICE_TOKEN = Symbol('IRehedgeDecisionService');
