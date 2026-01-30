import Decimal from 'decimal.js';
import {
  RiskFlags,
  RiskEvaluationInput,
  DrawdownCheckResult,
  MarginCheckResult,
  DexHealthResult,
  CexHealthResult,
  EmergencyExitDecision,
  EmergencyExitResult,
  RiskThresholds,
  RiskMonitoringState,
  HealthMetrics,
} from './risk.types';

/**
 * Risk Manager interface
 * Veto layer - blocks dangerous actions and triggers emergency exit
 */
export interface IRiskManager {
  // ==================== Main Methods (per spec) ====================

  /**
   * Evaluate current risk based on price, LP, and hedge state
   * @param input - Price result, LP composition, hedge snapshot
   * @returns Risk flags with emergency flag and reasons
   */
  evaluate(input: RiskEvaluationInput): Promise<RiskFlags>;

  /**
   * Check if LP range reset is allowed
   * Blocks reset when: cexDown, rpcDown, priceAnomaly, rate limits exceeded
   * @param riskFlags - Current risk flags
   * @returns true if reset is allowed
   */
  canExecuteReset(riskFlags: RiskFlags): boolean;

  /**
   * Check if rehedge is allowed
   * Blocks rehedge when: cexDown, priceAnomaly (unless marginDanger or bypass), operationInProgress
   * @param riskFlags - Current risk flags
   * @param bypassCooldown - If true, ignore cooldown (for gap_hard safety trigger)
   * @param bypassPriceAnomaly - If true, ignore price anomaly (for gap_hard safety trigger)
   * @param rehedgeMode - Rehedge mode for cooldown selection ('gap_soft' uses longer cooldown)
   * @returns true if rehedge is allowed
   */
  canExecuteRehedge(
    riskFlags: RiskFlags,
    bypassCooldown?: boolean,
    bypassPriceAnomaly?: boolean,
    rehedgeMode?: string,
  ): boolean;

  /**
   * Check if swap is allowed (per spec section 5)
   * Blocks swap when: priceAnomaly, rpcDown, dexTwap stale
   *
   * If swap is blocked, ExecutionOrchestrator should NOT continue with mint
   * because you risk:
   * - Swapping at a bad price
   * - Getting stuck mid-reset
   *
   * @param riskFlags - Current risk flags
   * @returns true if swap is allowed
   */
  canSwap(riskFlags: RiskFlags): boolean;

  /**
   * Record that a reset was executed (for rate limiting)
   */
  recordReset(): void;

  /**
   * Get reset rate limiting status
   */
  getResetRateLimitStatus(): {
    resetsIn24h: number;
    maxResetsAllowed: number;
    canReset: boolean;
    secondsUntilNextAllowed: number;
  };

  /**
   * Record that a rehedge was executed (for cooldown and delta tracking)
   * @param lpWethAmount - Current WETH amount in LP at time of rehedge
   * @param rehedgeMode - Mode of rehedge ('gap_soft' triggers separate cooldown tracking)
   */
  recordRehedge(lpWethAmount: Decimal, rehedgeMode?: string): void;

  /**
   * Get the LP WETH amount at last hedge (reference point for drift calculation)
   */
  getWethAtLastHedge(): Decimal | null;

  /**
   * Initialize WETH reference point (for bot startup when hedge already exists)
   * Only sets reference if not already set
   * @param lpWethAmount - Current WETH amount in LP
   */
  initializeWethReference(lpWethAmount: Decimal): void;

  /**
   * Get rehedge cooldown status
   */
  getRehedgeCooldownStatus(): {
    lastRehedgeAt: number | null;
    cooldownSec: number;
    canRehedge: boolean;
    secondsUntilNextAllowed: number;
  };

  // ==================== Check Methods ====================

  /**
   * Check maximum drawdown
   */
  checkMaxDrawdown(): Promise<DrawdownCheckResult>;

  /**
   * Check margin buffer
   */
  checkMarginBuffer(): Promise<MarginCheckResult>;

  /**
   * Check DEX health (RPC latency, gas prices)
   */
  checkDexHealth(): Promise<DexHealthResult>;

  /**
   * Check CEX health (API latency, errors)
   */
  checkCexHealth(): Promise<CexHealthResult>;

  /**
   * Run all health checks
   */
  runAllChecks(): Promise<HealthMetrics>;

  // ==================== Emergency ====================

  /**
   * Determine if emergency exit is needed based on checks
   */
  shouldEmergencyExit(): Promise<EmergencyExitDecision>;

  /**
   * Execute emergency exit
   * Closes hedge (reduce-only), removes LP, converts to USDC
   */
  emergencyExit(): Promise<EmergencyExitResult>;

  /**
   * Check if currently in emergency exit mode
   */
  isInEmergencyExit(): boolean;

  // ==================== State Management ====================

  /**
   * Get current monitoring state
   */
  getState(): RiskMonitoringState;

  /**
   * Get current thresholds
   */
  getThresholds(): RiskThresholds;

  /**
   * Update thresholds
   */
  updateThresholds(thresholds: Partial<RiskThresholds>): void;

  /**
   * Update peak value for drawdown calculation
   */
  updatePeakValue(value: Decimal): void;

  /**
   * Mark an operation as in progress
   */
  setOperationInProgress(inProgress: boolean): void;

  /**
   * Record a failure for consecutive failure tracking
   */
  recordFailure(error: Error): void;

  /**
   * Reset failure counter
   */
  resetFailures(): void;

  // ==================== Monitoring ====================

  /**
   * Start continuous risk monitoring
   */
  startMonitoring(intervalMs?: number): void;

  /**
   * Stop continuous monitoring
   */
  stopMonitoring(): void;
}
