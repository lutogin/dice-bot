import Decimal from 'decimal.js';

/**
 * Operation status
 */
export type OpStatus =
  | 'started'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'stuck'
  | 'rolled_back';

/**
 * Operation type
 */
export type OpType =
  | 'reset_range'
  | 'rehedge'
  | 'collect_fees'
  | 'emergency_exit'
  | 'rebalance_wallet';

// ==================== RESET_RANGE Step Names (per spec) ====================

/**
 * Fixed step names for RESET_RANGE operation
 * Ordered for deterministic resume
 */
export enum ResetRangeStep {
  /** 0. Operation initialized, beginOp recorded */
  STEP_INIT = 'STEP_INIT',
  /** 1. RPC/Binance/Price/Margin preflight passed */
  STEP_PREFLIGHT_OK = 'STEP_PREFLIGHT_OK',
  /** 2. Hedge safety passed (or reduced if margin < 35%) */
  STEP_HEDGE_SAFETY_OK = 'STEP_HEDGE_SAFETY_OK',
  /** 3. Decrease liquidity tx sent */
  STEP_DECREASE_SENT = 'STEP_DECREASE_SENT',
  /** 4. Decrease liquidity tx confirmed */
  STEP_DECREASE_CONFIRMED = 'STEP_DECREASE_CONFIRMED',
  /** 5. Collect tx sent */
  STEP_COLLECT_SENT = 'STEP_COLLECT_SENT',
  /** 6. Collect tx confirmed */
  STEP_COLLECT_CONFIRMED = 'STEP_COLLECT_CONFIRMED',
  /** 7. Balances snapshot taken */
  STEP_BALANCES_SNAPSHOT = 'STEP_BALANCES_SNAPSHOT',
  /** 8a. Swap skipped (deviation <= threshold) */
  STEP_SWAP_SKIPPED = 'STEP_SWAP_SKIPPED',
  /** 8b. Swap tx sent */
  STEP_SWAP_SENT = 'STEP_SWAP_SENT',
  /** 8c. Swap tx confirmed */
  STEP_SWAP_CONFIRMED = 'STEP_SWAP_CONFIRMED',
  /** 9. Allowances ensured (USDC + WETH) */
  STEP_ALLOWANCES_OK = 'STEP_ALLOWANCES_OK',
  /** 10. Mint tx sent */
  STEP_MINT_SENT = 'STEP_MINT_SENT',
  /** 11. Mint tx confirmed, newTokenId extracted */
  STEP_MINT_CONFIRMED = 'STEP_MINT_CONFIRMED',
  /** 12. Hedge adjusted after reset */
  STEP_HEDGE_AFTER_RESET_OK = 'STEP_HEDGE_AFTER_RESET_OK',
  /** 13. Ledger recorded */
  STEP_LEDGER_RECORDED = 'STEP_LEDGER_RECORDED',
  /** 14. Operation complete, activeTokenId updated */
  STEP_DONE = 'STEP_DONE',
}

/**
 * Step order for resume logic
 */
export const RESET_RANGE_STEP_ORDER: ResetRangeStep[] = [
  ResetRangeStep.STEP_INIT,
  ResetRangeStep.STEP_PREFLIGHT_OK,
  ResetRangeStep.STEP_HEDGE_SAFETY_OK,
  ResetRangeStep.STEP_DECREASE_SENT,
  ResetRangeStep.STEP_DECREASE_CONFIRMED,
  ResetRangeStep.STEP_COLLECT_SENT,
  ResetRangeStep.STEP_COLLECT_CONFIRMED,
  ResetRangeStep.STEP_BALANCES_SNAPSHOT,
  // Note: SWAP_SKIPPED, SWAP_SENT, SWAP_CONFIRMED are mutually exclusive paths
  ResetRangeStep.STEP_SWAP_SKIPPED,
  ResetRangeStep.STEP_SWAP_SENT,
  ResetRangeStep.STEP_SWAP_CONFIRMED,
  ResetRangeStep.STEP_ALLOWANCES_OK,
  ResetRangeStep.STEP_MINT_SENT,
  ResetRangeStep.STEP_MINT_CONFIRMED,
  ResetRangeStep.STEP_HEDGE_AFTER_RESET_OK,
  ResetRangeStep.STEP_LEDGER_RECORDED,
  ResetRangeStep.STEP_DONE,
];

// ==================== RESET_RANGE Data Structures ====================

/**
 * Transaction hashes for RESET_RANGE operation
 */
export interface ResetRangeTxHashes {
  decreaseTxHash?: string;
  collectTxHash?: string;
  swapTxHash?: string;
  mintTxHash?: string;
  approveTxHashes?: string[];
}

/**
 * Swap data for RESET_RANGE operation
 */
export interface ResetRangeSwapData {
  performed: boolean;
  direction?: 'USDC_TO_WETH' | 'WETH_TO_USDC';
  amountIn?: string;
  amountOutMin?: string;
  amountOut?: string;
}

/**
 * Mint data for RESET_RANGE operation
 */
export interface ResetRangeMintData {
  newTokenId?: string;
  amount0Desired?: string;
  amount1Desired?: string;
  amount0Min?: string;
  amount1Min?: string;
  amount0Used?: string;
  amount1Used?: string;
  liquidity?: string;
}

/**
 * Hedge data for RESET_RANGE operation
 */
export interface ResetRangeHedgeData {
  /** Target before safety reduce (if performed) */
  targetShortUsdcBefore?: string;
  /** Target after mint */
  targetShortUsdcAfter?: string;
  /** Order IDs from Binance */
  hedgeOrderIds?: string[];
  /** Hedge adjustment mode used */
  hedgeMode?: string;
}

/**
 * Attempt counts for retries
 */
export interface ResetRangeAttempts {
  swapAttempts: number;
  mintAttempts: number;
  hedgeAttempts: number;
}

/**
 * Balance snapshot for RESET_RANGE
 */
export interface BalanceSnapshot {
  usdc: string;
  weth: string;
  ethForGas: string;
  totalValueUsdc?: string;
}

/**
 * Complete RESET_RANGE operation data
 */
export interface ResetRangeOpData {
  /** Old NFT token ID being replaced */
  activeTokenIdBefore: string;
  /** New tick range */
  newTicks: {
    newTickLower: number;
    newTickUpper: number;
  };
  /** Reference price used for calculations */
  referencePrice: string;
  /** Transaction hashes */
  tx: ResetRangeTxHashes;
  /** Swap details */
  swap?: ResetRangeSwapData;
  /** Mint details */
  mint?: ResetRangeMintData;
  /** Hedge details */
  hedge?: ResetRangeHedgeData;
  /** Retry attempts */
  attempts: ResetRangeAttempts;
  /** Balance snapshots */
  balancesBeforeRebalance?: BalanceSnapshot;
  balancesAfterRebalance?: BalanceSnapshot;
  balancesAfterMint?: BalanceSnapshot;
  /** Last errors */
  errors: string[];
}

// ==================== Step State ====================

/**
 * Step state
 */
export interface StepState {
  /** Step name */
  stepName: string;
  /** Step status */
  status: 'pending' | 'started' | 'completed' | 'failed';
  /** When step started */
  startedAt?: number;
  /** When step completed */
  completedAt?: number;
  /** Step-specific data */
  data?: Record<string, any>;
  /** Transaction hash if applicable */
  txHash?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Operation state
 */
export interface OpState {
  /** Unique operation ID */
  operationId: string;
  /** Operation type */
  type: OpType;
  /** Operation status */
  status: OpStatus;
  /** Operation data */
  data: Record<string, any>;
  /** Steps in this operation */
  steps: StepState[];
  /** When operation started (ms) */
  startedAt: number;
  /** Last update time (ms) */
  updatedAt: number;
  /** When operation completed (ms) */
  completedAt?: number;
  /** Error message if failed */
  error?: string;
  /** Number of retries */
  retryCount: number;
  /** Last heartbeat (ms) */
  lastHeartbeat: number;
}

/**
 * Begin operation input
 */
export interface BeginOpInput {
  /** Operation type */
  type: OpType;
  /** Initial data */
  data?: Record<string, any>;
  /** Expected steps (optional, for planning) */
  expectedSteps?: string[];
}

/**
 * Mark step input
 */
export interface MarkStepInput {
  /** Step name */
  stepName: string;
  /** Data to merge into step */
  dataPatch?: Record<string, any>;
  /** Transaction hash */
  txHash?: string;
}

/**
 * State store config
 */
export interface StateStoreConfig {
  /** Heartbeat interval in ms */
  heartbeatIntervalMs: number;
  /** Stuck operation timeout in ms */
  stuckTimeoutMs: number;
  /** Enable auto-cleanup of old operations */
  autoCleanup: boolean;
  /** Days to keep completed operations */
  cleanupOlderThanDays: number;
}

/**
 * Default state store config
 */
export const DEFAULT_STATE_STORE_CONFIG: StateStoreConfig = {
  heartbeatIntervalMs: 10000, // 10 seconds
  stuckTimeoutMs: 60000, // 1 minute
  autoCleanup: true,
  cleanupOlderThanDays: 30,
};

// ==================== LP Bounds Cache ====================

/**
 * Cached LP position bounds for cheap in-range checks
 * Updated: on startup, after reset, periodic reconciliation (every 10-30 min)
 * Used: to check if price is near boundary without heavy RPC calls
 */
export interface LpBoundsCache {
  /** Token ID this cache belongs to */
  tokenId: string;
  /** Lower tick boundary */
  tickLower: number;
  /** Upper tick boundary */
  tickUpper: number;
  /** Fee tier (500, 3000, 10000) */
  feeTier: number;
  /** Pool address */
  poolAddress: string;
  /** When bounds were last confirmed from chain */
  lastConfirmedAt: number;
  /** Whether cache is considered fresh (< 30 min old) */
  isFresh?: boolean;
}

/**
 * Default empty LP bounds cache
 */
export const EMPTY_LP_BOUNDS_CACHE: LpBoundsCache | null = null;

// ==================== Global State ====================

/**
 * Global state persisted in StateStore
 * (separate from operation-specific state)
 */
export interface GlobalState {
  /** Currently active LP NFT token ID */
  activeTokenId: string | null;
  /** When active token ID was last updated */
  activeTokenIdUpdatedAt?: number | null;
  /** Tx hash associated with active token update (mint tx) */
  activeTokenIdTxHash?: string | null;
  /** Operation ID that set the active token */
  activeTokenIdSourceOpId?: string | null;
  /** Last reset timestamp */
  lastResetAt: number | null;
  /** Count of resets in last 24h */
  resetsCount24h: number;
  /** Reset timestamps for rate limiting */
  resetTimestamps: number[];
  /** Cached LP bounds for cheap in-range checks */
  lpBoundsCache?: LpBoundsCache | null;

  // ==================== Rehedge Delta Drift Tracking ====================
  /** Timestamp of last rehedge (for cooldown) */
  lastRehedgeAt?: number | null;
  /** Timestamp of last soft gap rehedge (separate longer cooldown) */
  lastSoftGapRehedgeAt?: number | null;
  /** LP WETH amount at last hedge (reference for delta drift calculation) */
  wethAtLastHedge?: string | null; // Stored as string for Decimal serialization

  // ==================== Hysteresis State ====================
  /**
   * Hysteresis state for rehedge decision
   * STABLE = waiting for drift to exceed ENTER threshold
   * ADJUSTED = recently rehedged, waiting for drift to fall below EXIT threshold
   */
  hysteresisState?: 'STABLE' | 'ADJUSTED';

  // ==================== LP Delta EMA Tracking ====================
  /**
   * EMA of LP WETH delta for smoothed drift calculation
   * Updated on each evaluation to filter out noise
   * Formula: EMA_new = alpha * value + (1 - alpha) * EMA_old
   */
  lpDeltaEma?: string | null;

  /**
   * Timestamp of last EMA update (ms)
   */
  lpDeltaEmaUpdatedAt?: number | null;

  /**
   * Anchor LP WETH amount - reference point for drift calculation
   * Updated ONLY when:
   * 1. Entering boundary zone (protective mode)
   * 2. After LP range reset
   * 3. After rehedge execution
   * This prevents "saw" pattern by not resetting anchor on every small move
   */
  lpDeltaAnchor?: string | null;

  /**
   * Timestamp when anchor was last set (ms)
   */
  lpDeltaAnchorSetAt?: number | null;

  /**
   * Reason for last anchor update (for debugging)
   */
  lpDeltaAnchorReason?: string | null;

  /**
   * Last zone from rehedge decision (for boundary entry detection)
   * Used to detect zone transitions: middle → lower/upper = boundary entry
   */
  lastDecisionZone?: 'lower' | 'middle' | 'upper' | null;
}

/**
 * Default global state
 */
export const DEFAULT_GLOBAL_STATE: GlobalState = {
  activeTokenId: null,
  activeTokenIdUpdatedAt: null,
  activeTokenIdTxHash: null,
  activeTokenIdSourceOpId: null,
  lastResetAt: null,
  resetsCount24h: 0,
  resetTimestamps: [],
  lastRehedgeAt: null,
  lastSoftGapRehedgeAt: null,
  wethAtLastHedge: null,
  hysteresisState: 'STABLE',
  lpDeltaEma: null,
  lpDeltaEmaUpdatedAt: null,
  lpDeltaAnchor: null,
  lpDeltaAnchorSetAt: null,
  lpDeltaAnchorReason: null,
  lastDecisionZone: null,
};

/**
 * Metadata for active token updates
 */
export interface ActiveTokenUpdate {
  txHash?: string;
  sourceOpId?: string;
  updatedAt?: number;
}

// ==================== Resume Helpers ====================

/**
 * Get the next step after the given step
 */
export function getNextStep(
  currentStep: ResetRangeStep,
): ResetRangeStep | null {
  const idx = RESET_RANGE_STEP_ORDER.indexOf(currentStep);
  if (idx === -1 || idx >= RESET_RANGE_STEP_ORDER.length - 1) {
    return null;
  }
  return RESET_RANGE_STEP_ORDER[idx + 1];
}

/**
 * Check if step A is before step B in the order
 */
export function isStepBefore(
  stepA: ResetRangeStep,
  stepB: ResetRangeStep,
): boolean {
  const idxA = RESET_RANGE_STEP_ORDER.indexOf(stepA);
  const idxB = RESET_RANGE_STEP_ORDER.indexOf(stepB);
  return idxA < idxB;
}

/**
 * Check if a step is a "SENT" step (needs confirmation)
 */
export function isSentStep(step: ResetRangeStep): boolean {
  return (
    step === ResetRangeStep.STEP_DECREASE_SENT ||
    step === ResetRangeStep.STEP_COLLECT_SENT ||
    step === ResetRangeStep.STEP_SWAP_SENT ||
    step === ResetRangeStep.STEP_MINT_SENT
  );
}

/**
 * Get the corresponding CONFIRMED step for a SENT step
 */
export function getConfirmedStep(
  sentStep: ResetRangeStep,
): ResetRangeStep | null {
  const map: Partial<Record<ResetRangeStep, ResetRangeStep>> = {
    [ResetRangeStep.STEP_DECREASE_SENT]: ResetRangeStep.STEP_DECREASE_CONFIRMED,
    [ResetRangeStep.STEP_COLLECT_SENT]: ResetRangeStep.STEP_COLLECT_CONFIRMED,
    [ResetRangeStep.STEP_SWAP_SENT]: ResetRangeStep.STEP_SWAP_CONFIRMED,
    [ResetRangeStep.STEP_MINT_SENT]: ResetRangeStep.STEP_MINT_CONFIRMED,
  };
  return map[sentStep] || null;
}

/**
 * Get txHash field name for a step
 */
export function getTxHashField(
  step: ResetRangeStep,
): keyof ResetRangeTxHashes | null {
  const map: Partial<Record<ResetRangeStep, keyof ResetRangeTxHashes>> = {
    [ResetRangeStep.STEP_DECREASE_SENT]: 'decreaseTxHash',
    [ResetRangeStep.STEP_DECREASE_CONFIRMED]: 'decreaseTxHash',
    [ResetRangeStep.STEP_COLLECT_SENT]: 'collectTxHash',
    [ResetRangeStep.STEP_COLLECT_CONFIRMED]: 'collectTxHash',
    [ResetRangeStep.STEP_SWAP_SENT]: 'swapTxHash',
    [ResetRangeStep.STEP_SWAP_CONFIRMED]: 'swapTxHash',
    [ResetRangeStep.STEP_MINT_SENT]: 'mintTxHash',
    [ResetRangeStep.STEP_MINT_CONFIRMED]: 'mintTxHash',
  };
  return map[step] || null;
}
