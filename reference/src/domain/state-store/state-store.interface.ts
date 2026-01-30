import {
  OpState,
  BeginOpInput,
  MarkStepInput,
  StateStoreConfig,
  ResetRangeStep,
  ResetRangeOpData,
  GlobalState,
  ActiveTokenUpdate,
  LpBoundsCache,
} from './state-store.types';

/**
 * State Store Service interface
 *
 * Purpose: Prevent executing multi-step operations twice
 * and allow recovery after process crash
 *
 * Dependencies:
 * - ConfigService
 * - StateStoreRepository
 * - MonitoringService (for stuck operation alerts)
 */
export interface IStateStore {
  /**
   * Get current in-flight (non-completed) operation
   * @returns Operation state or null if no operation in progress
   */
  getInFlightOp(): Promise<OpState | null>;

  /**
   * Begin a new operation
   * Creates operation record with status "started"
   * @param input - Operation type and initial data
   * @returns Created operation state
   * @throws Error if another operation is already in progress
   */
  beginOp(input: BeginOpInput): Promise<OpState>;

  /**
   * Mark a step as completed
   * Records that step was executed and saves txHash/other data
   * @param opId - Operation ID
   * @param input - Step name and data to save
   */
  markStep(opId: string, input: MarkStepInput): Promise<void>;

  /**
   * Mark a step as started
   * @param opId - Operation ID
   * @param stepName - Step name
   */
  markStepStarted(opId: string, stepName: string): Promise<void>;

  /**
   * Mark a step as failed
   * @param opId - Operation ID
   * @param stepName - Step name
   * @param error - Error message
   */
  markStepFailed(opId: string, stepName: string, error: string): Promise<void>;

  /**
   * Complete the operation
   * Marks operation as finished
   * @param opId - Operation ID
   */
  completeOp(opId: string): Promise<void>;

  /**
   * Fail the operation
   * Marks operation as failed with error
   * @param opId - Operation ID
   * @param error - Error message
   */
  failOp(opId: string, error: string): Promise<void>;

  /**
   * Update heartbeat for current operation
   * Should be called periodically during long operations
   * @param opId - Operation ID
   */
  heartbeat(opId: string): Promise<void>;

  /**
   * Check for stuck operations
   * @returns List of stuck operation IDs
   */
  checkStuck(): Promise<string[]>;

  /**
   * Get operation by ID
   * @param opId - Operation ID
   * @returns Operation state or null
   */
  getOp(opId: string): Promise<OpState | null>;

  /**
   * Check if there is an operation in progress
   * @returns True if operation is in progress
   */
  hasInFlightOp(): Promise<boolean>;

  /**
   * Get current config
   */
  getConfig(): StateStoreConfig;

  /**
   * Start background tasks (heartbeat checker, cleanup)
   */
  start(): Promise<void>;

  /**
   * Stop background tasks
   */
  stop(): Promise<void>;

  // ==================== Active Token Management ====================

  /**
   * Get the currently active LP NFT token ID
   * @returns Token ID or null if not set
   */
  getActiveTokenId(): Promise<string | null>;

  /**
   * Set the active LP NFT token ID
   * Called after successful mint of new position
   * @param tokenId - New token ID
   */
  setActiveTokenId(tokenId: string, meta?: ActiveTokenUpdate): Promise<void>;

  /**
   * Clear the active LP NFT token ID
   *
   * Called when:
   * - LP position is closed (before new mint in reset)
   * - Emergency exit is executed
   * - LP is removed for any reason
   *
   * This ensures bot doesn't try to use a closed/empty LP on restart.
   *
   * @param reason - Reason for clearing (for logging/audit)
   * @param sourceOpId - Operation ID that triggered the clear
   */
  clearActiveTokenId(reason: string, sourceOpId?: string): Promise<void>;

  /**
   * Commit reset completion: update active token + reset timestamps + anchor, then complete op
   * @param opId - Operation ID
   * @param tokenId - New active token ID
   * @param lpWethAmount - LP WETH amount after reset (for anchor)
   * @param meta - Optional metadata for token update
   */
  completeReset(
    opId: string,
    tokenId: string,
    lpWethAmount: string,
    meta?: ActiveTokenUpdate,
  ): Promise<void>;

  /**
   * Get last reset timestamp
   * @returns Timestamp of last reset or null
   */
  getLastResetAt(): Promise<number | null>;

  /**
   * Record reset timestamp (for rate limiting)
   */
  recordReset(): Promise<void>;

  /**
   * Get reset count in last 24 hours
   * @returns Number of resets in last 24h
   */
  getResetsCount24h(): Promise<number>;

  // ==================== Resume & Idempotency Helpers ====================

  /**
   * Get the last completed step for an operation
   * @param opId - Operation ID
   * @returns Last completed step name or null
   */
  getLastCompletedStep(opId: string): Promise<ResetRangeStep | null>;

  /**
   * Check if a step has been completed
   * @param opId - Operation ID
   * @param step - Step to check
   * @returns True if step is completed
   */
  isStepCompleted(opId: string, step: ResetRangeStep): Promise<boolean>;

  /**
   * Check if a step is currently in "SENT" status (tx pending)
   * @param opId - Operation ID
   * @param step - Step to check
   * @returns True if step is in SENT/started state
   */
  isStepPending(opId: string, step: ResetRangeStep): Promise<boolean>;

  /**
   * Get transaction hash for a step
   * @param opId - Operation ID
   * @param step - Step name
   * @returns Transaction hash or null
   */
  getStepTxHash(opId: string, step: ResetRangeStep): Promise<string | null>;

  /**
   * Update transaction hash for a step (e.g., after bump and replace)
   * @param opId - Operation ID
   * @param step - Step name
   * @param newTxHash - New transaction hash
   */
  updateStepTxHash(
    opId: string,
    step: ResetRangeStep,
    newTxHash: string,
  ): Promise<void>;

  /**
   * Get typed RESET_RANGE operation data
   * @param opId - Operation ID
   * @returns Typed operation data or null
   */
  getResetRangeData(opId: string): Promise<ResetRangeOpData | null>;

  /**
   * Update RESET_RANGE operation data (merge)
   * @param opId - Operation ID
   * @param patch - Data to merge
   */
  updateResetRangeData(
    opId: string,
    patch: Partial<ResetRangeOpData>,
  ): Promise<void>;

  /**
   * Increment attempt counter
   * @param opId - Operation ID
   * @param attemptType - Type of attempt (swap, mint, hedge)
   * @returns New attempt count
   */
  incrementAttempt(
    opId: string,
    attemptType: 'swap' | 'mint' | 'hedge',
  ): Promise<number>;

  /**
   * Add error to operation's error list
   * @param opId - Operation ID
   * @param error - Error message
   */
  addError(opId: string, error: string): Promise<void>;

  // ==================== LP Bounds Cache ====================

  /**
   * Get cached LP bounds for cheap in-range checks
   * @returns Cached bounds or null if not available
   */
  getLpBoundsCache(): LpBoundsCache | null;

  /**
   * Update LP bounds cache
   * Called after reading position from chain (startup, reset, periodic sync)
   * @param bounds - New bounds to cache
   */
  setLpBoundsCache(bounds: LpBoundsCache): Promise<void>;

  /**
   * Clear LP bounds cache
   * Called when LP is closed or token changes
   */
  clearLpBoundsCache(): Promise<void>;

  /**
   * Check if cached bounds are still fresh (< maxAgeMs old)
   * @param maxAgeMs - Maximum age in ms (default 30 min)
   * @returns True if cache is fresh
   */
  isLpBoundsCacheFresh(maxAgeMs?: number): boolean;

  /**
   * Quick check if current tick is in range using cached bounds
   * Does NOT make any RPC calls
   * @param currentTick - Current pool tick
   * @returns { inRange, distanceToLower, distanceToUpper } or null if no cache
   */
  checkInRangeFromCache(currentTick: number): {
    inRange: boolean;
    distanceToLowerPercent: number;
    distanceToUpperPercent: number;
  } | null;

  /**
   * Force refresh LP bounds from chain
   * Called periodically for reconciliation (every 10-30 min)
   */
  refreshLpBounds(): Promise<void>;

  // ==================== Global State Persistence ====================

  /**
   * Get full global state
   * @returns Global state
   */
  getGlobalState(): Promise<GlobalState>;

  /**
   * Save global state to persistence
   * Called after important updates (e.g., setActiveTokenId)
   */
  persistGlobalState(): Promise<void>;

  /**
   * Load global state from persistence
   * Called on startup
   */
  loadGlobalState(): Promise<void>;

  // ==================== Rehedge Delta Drift Tracking ====================

  /**
   * Record rehedge execution (for cooldown and delta drift tracking)
   * @param lpWethAmount - Current LP WETH amount at time of rehedge
   * @param rehedgeMode - Mode of rehedge ('gap_soft' triggers separate cooldown tracking)
   */
  recordRehedge(lpWethAmount: string, rehedgeMode?: string): Promise<void>;

  /**
   * Get timestamp of last rehedge
   */
  getLastRehedgeAt(): number | null;

  /**
   * Get timestamp of last soft gap rehedge (separate cooldown)
   */
  getLastSoftGapRehedgeAt(): number | null;

  /**
   * Get LP WETH amount at last hedge (reference for delta drift)
   */
  getWethAtLastHedge(): string | null;

  /**
   * Initialize WETH reference (for bot startup when hedge already exists)
   * Only sets if not already set
   */
  initializeWethReference(lpWethAmount: string): Promise<void>;

  // ==================== Hysteresis State Management ====================

  /**
   * Get current hysteresis state
   * @returns 'STABLE' or 'ADJUSTED'
   */
  getHysteresisState(): 'STABLE' | 'ADJUSTED';

  /**
   * Set hysteresis state to ADJUSTED (after rehedge)
   */
  setHysteresisAdjusted(): Promise<void>;

  /**
   * Set hysteresis state to STABLE (when drift falls below exit threshold)
   */
  setHysteresisStable(): Promise<void>;

  // ==================== LP Delta EMA Tracking ====================

  /**
   * Get current LP delta EMA
   * @returns EMA value as string or null if not initialized
   */
  getLpDeltaEma(): string | null;

  /**
   * Get timestamp of last EMA update
   * @returns Timestamp in ms or null if not initialized
   */
  getLpDeltaEmaUpdatedAt(): number | null;

  /**
   * Update LP delta EMA with new value
   * @param emaValue - New EMA value as string
   */
  updateLpDeltaEma(emaValue: string): Promise<void>;

  /**
   * Get LP delta anchor (reference point for drift calculation)
   * @returns Anchor value as string or null if not set
   */
  getLpDeltaAnchor(): string | null;

  /**
   * Set LP delta anchor
   * Called when:
   * 1. Entering boundary zone
   * 2. After LP range reset
   * 3. After rehedge execution
   * @param anchorValue - Anchor LP WETH amount as string
   * @param reason - Reason for setting anchor (for debugging)
   */
  setLpDeltaAnchor(anchorValue: string, reason: string): Promise<void>;

  /**
   * Get timestamp when anchor was last set
   * @returns Timestamp in ms or null
   */
  getLpDeltaAnchorSetAt(): number | null;

  /**
   * Get last decision zone (for boundary entry detection)
   * @returns Last zone or null if not set
   */
  getLastDecisionZone(): 'lower' | 'middle' | 'upper' | null;

  /**
   * Set last decision zone (called after each rehedge decision)
   * @param zone - Current zone from decision
   */
  setLastDecisionZone(zone: 'lower' | 'middle' | 'upper'): void;
}
