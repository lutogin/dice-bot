import Decimal from 'decimal.js';
import type { RiskFlags } from '../risk/risk.types';
import type { DynamicRangeResult } from '../range-model';
import type { RehedgeDecisionResult } from '../rehedge-decision';
import {
  LpCompositionInput,
  HedgeInput,
  RangeBounds,
  ActionPlan,
  StrategyThresholds,
  StrategyState,
  ResetDecision,
  NewRangeBounds,
} from './strategy.types';

/**
 * Strategy Engine interface
 * Converts inputs (price, LP, hedge, risks) into ActionPlan
 */
export interface IStrategyEngine {
  /**
   * Compute target short notional based on LP composition
   * @param lpComposition - LP composition with wethAmount
   * @param referencePrice - Current reference price
   * @returns Target short notional in USDC
   */
  computeHedgeTarget(lpComposition: LpCompositionInput, referencePrice: Decimal): Decimal;

  /**
   * Evaluate if LP range should be reset with detailed decision
   * Checks out-of-range and near-boundary conditions
   * @param lpComposition - LP composition with tick info
   * @param referencePrice - Current reference price
   * @returns Detailed reset decision
   */
  evaluateResetNeed(lpComposition: LpCompositionInput, referencePrice: Decimal): ResetDecision;

  /**
   * Determine if LP range should be reset (simple boolean)
   * @param lpComposition - LP composition with tick info
   * @param referencePrice - Current reference price
   * @returns true if reset needed
   */
  shouldResetRange(lpComposition: LpCompositionInput, referencePrice: Decimal): boolean;

  /**
   * Determine if rehedge is needed based on dual-trigger logic:
   * 1. LP Delta Drift (primary) - rehedge when accumulated drift exceeds threshold
   * 2. Zone-based protection (secondary) - more aggressive hedging near LP boundaries
   * 
   * @param currentShortUsdc - Current short notional
   * @param targetShortUsdc - Target short notional
   * @param currentWethAmount - Current WETH amount in LP
   * @param referencePrice - Reference ETH price
   * @param lpComposition - LP composition (optional, for zone calculation)
   * @returns Decision result with details (shouldRehedge, mode, zone, etc.)
   */
  shouldRehedge(
    currentShortUsdc: Decimal,
    targetShortUsdc: Decimal,
    currentWethAmount: Decimal,
    referencePrice: Decimal,
    lpComposition?: LpCompositionInput
  ): RehedgeDecisionResult;

  /**
   * Build action plan based on all inputs
   * Priority: EMERGENCY > RESET_RANGE > REHEDGE > NONE
   * @param riskFlags - Risk flags from RiskManager
   * @param lpComposition - LP composition
   * @param hedge - Hedge state
   * @param referencePrice - Reference price
   * @param tokenId - LP NFT token ID (for reset params)
   * @returns Action plan
   */
  buildPlan(
    riskFlags: RiskFlags,
    lpComposition: LpCompositionInput,
    hedge: HedgeInput,
    referencePrice: Decimal,
    tokenId: string
  ): Promise<ActionPlan>;

  /**
   * Compute new range ticks around reference price (simple)
   * @param referencePrice - Center price for new range
   * @returns New tick bounds
   */
  computeNewRange(referencePrice: Decimal): RangeBounds;

  /**
   * Compute new range with full validation and sanity check
   * Applies floor/ceil tick spacing rounding per spec
   * @param referencePrice - Center price for new range
   * @param currentPoolTick - Optional current pool tick for sanity check
   * @returns New range bounds with validation status
   */
  computeNewRangeWithValidation(referencePrice: Decimal, currentPoolTick?: number): Promise<NewRangeBounds>;

  // ==================== Legacy / Utility ====================

  /**
   * Get current thresholds
   */
  getThresholds(): StrategyThresholds;

  /**
   * Update thresholds
   */
  updateThresholds(thresholds: Partial<StrategyThresholds>): void;

  /**
   * Get last state
   */
  getLastState(): StrategyState | null;

  /**
   * Get last dynamic range result from RangeModelService (for diagnostics)
   * Returns null if no dynamic range has been calculated yet
   */
  getLastDynamicRange(): DynamicRangeResult | null;
}
