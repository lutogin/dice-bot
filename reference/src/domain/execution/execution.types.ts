import Decimal from 'decimal.js';
import { ActionPlan, ActionPlanType } from '../strategy/strategy.types';
import { OpState, OpType, StepState } from '../state-store/state-store.types';
import { HedgeUrgency } from '../hedge/hedge.types';

/**
 * Execution result status
 */
export type ExecutionStatus =
  | 'success'
  | 'partial'
  | 'failed'
  | 'aborted'
  | 'resumed'
  | 'skipped';

/**
 * Execution result returned by execute methods
 */
export interface ExecutionResult {
  /** Operation ID from StateStore */
  operationId?: string;
  /** Execution status */
  status: ExecutionStatus;
  /** What was executed */
  operationType: OpType | 'none';
  /** Start timestamp */
  startedAt: number;
  /** End timestamp */
  completedAt: number;
  /** Duration in ms */
  durationMs: number;
  /** Steps executed */
  stepsCompleted: string[];
  /** Steps failed */
  stepsFailed: string[];
  /** Transaction hashes from on-chain actions */
  txHashes: string[];
  /** Order IDs from CEX actions */
  orderIds: string[];
  /** Error if failed */
  error?: string;
  /** Summary message */
  summary: string;
  /** Additional data */
  data?: Record<string, any>;
}

/**
 * Rehedge execution parameters
 */
export interface RehedgeParams {
  /** Target short notional in USDC */
  targetShortUsdc: Decimal;
  /** Current LP WETH amount (for delta drift tracking) */
  lpWethAmount: Decimal;
  /** Execution urgency (determines maker-prefer vs IOC/market) */
  urgency?: HedgeUrgency;
  /** @deprecated Use urgency instead */
  mode?: 'makerPrefer' | 'iocMarket';
  /** Delta drift percentage that triggered rehedge (for event reporting) */
  deltaDriftPercent?: Decimal;
  /** Effective threshold used for decision (for event reporting) */
  effectiveThreshold?: Decimal;
  /** Existing operation ID (for resume - skips beginOp) */
  existingOperationId?: string;
  /** Rehedge mode from decision (for cooldown tracking: 'gap_soft' uses longer cooldown) */
  rehedgeMode?: string;
  /** Human-readable reason for rehedge (for telegram notification) */
  reason?: string;
}

/**
 * Reset range execution parameters (per A0 runbook)
 */
export interface ResetRangeParams {
  /** Reference price (from PriceService) */
  referencePrice?: Decimal;
  /** New tick lower (±10% rounded to tickSpacing=10) */
  newTickLower: number;
  /** New tick upper */
  newTickUpper: number;
  /** Old token ID to reset */
  oldTokenId?: string;
  /** Reason for reset (near boundary / out of range) */
  reason?: string;
  /** Whether to rebalance wallet to 50/50 before mint */
  rebalanceWallet: boolean;
  /** Max slippage for swaps in bps (MVP: 30 = 0.30%) */
  maxSlippageBps?: number;
  /** Hedge safety threshold (reduce if liq distance < this) */
  hedgeSafetyThresholdPercent?: number;
}

/**
 * Emergency exit parameters
 */
export interface EmergencyExitParams {
  /** Reason for emergency exit */
  reason: string;
  /** Detailed reasons for emergency exit */
  triggerReasons?: string[];
  /** Whether to swap everything to USDC */
  swapToUsdc?: boolean;
}

/**
 * Step execution result (internal)
 */
export interface StepResult {
  /** Step name */
  stepName: string;
  /** Success */
  success: boolean;
  /** Transaction hash if applicable */
  txHash?: string;
  /** Order ID if applicable */
  orderId?: string;
  /** Error message if failed */
  error?: string;
  /** Data returned by the step */
  data?: Record<string, any>;
}

/**
 * Steps for REHEDGE operation (B runbook)
 *
 * B1. Preflight (Binance API ok, symbol available, minNotional check)
 * B2. Compute diff and action
 * B3-B4. Execute order (limit post-only → fallback IOC/market)
 * B5. Record ledger
 */
export const REHEDGE_STEPS = {
  /** B1: Preflight checks */
  PREFLIGHT: 'preflight_check',
  /** B2-B4: Set target short (includes order execution) */
  SET_TARGET: 'set_target_short',
  /** B5: Record in ledger */
  RECORD_LEDGER: 'record_ledger',
} as const;

/**
 * Steps for RESET_RANGE operation (A runbook)
 *
 * A1. Preflight (жёсткий gate)
 * A2. Заморозка риска по шорту ("не остаться голым")
 * A3. Снять ликвидность со старого NFT
 * A4. Забрать всё на кошелёк (collect)
 * A5. Определить, нужно ли балансировать под 50/50
 * A6. Балансировка (swap) под 50/50
 * A7. Approvals
 * A8. Mint нового NFT
 * A9. Пересчитать экспозицию и выставить target short
 * A10. Закрытие операции
 */
/**
 * RESET_RANGE step names
 * Maps to ResetRangeStep enum in state-store for resume logic
 *
 * @deprecated Use ResetRangeStep enum from state-store.types instead
 */
export const RESET_RANGE_STEPS = {
  // Per spec: STEP_* format with SENT/CONFIRMED separation
  /** 0. STEP_INIT - beginOp recorded */
  INIT: 'STEP_INIT',
  /** 1. STEP_PREFLIGHT_OK - RPC/Binance/Price/Margin checks passed */
  PREFLIGHT: 'STEP_PREFLIGHT_OK',
  /** 2. STEP_HEDGE_SAFETY_OK - Hedge safety passed */
  HEDGE_SAFETY: 'STEP_HEDGE_SAFETY_OK',
  /** 3. STEP_DECREASE_SENT - Decrease liquidity tx sent */
  DECREASE_SENT: 'STEP_DECREASE_SENT',
  /** 4. STEP_DECREASE_CONFIRMED - Decrease liquidity tx confirmed */
  DECREASE_CONFIRMED: 'STEP_DECREASE_CONFIRMED',
  /** 5. STEP_COLLECT_SENT - Collect tx sent */
  COLLECT_SENT: 'STEP_COLLECT_SENT',
  /** 6. STEP_COLLECT_CONFIRMED - Collect tx confirmed */
  COLLECT_CONFIRMED: 'STEP_COLLECT_CONFIRMED',
  /** 7. STEP_BALANCES_SNAPSHOT - Balances snapshot taken */
  BALANCES_SNAPSHOT: 'STEP_BALANCES_SNAPSHOT',
  /** 8a. STEP_SWAP_SKIPPED - Swap skipped (deviation <= threshold) */
  SWAP_SKIPPED: 'STEP_SWAP_SKIPPED',
  /** 8b. STEP_SWAP_SENT - Swap tx sent */
  SWAP_SENT: 'STEP_SWAP_SENT',
  /** 8c. STEP_SWAP_CONFIRMED - Swap tx confirmed */
  SWAP_CONFIRMED: 'STEP_SWAP_CONFIRMED',
  /** 9. STEP_ALLOWANCES_OK - Allowances ensured */
  ALLOWANCES_OK: 'STEP_ALLOWANCES_OK',
  /** 10. STEP_MINT_SENT - Mint tx sent */
  MINT_SENT: 'STEP_MINT_SENT',
  /** 11. STEP_MINT_CONFIRMED - Mint tx confirmed, newTokenId extracted */
  MINT_CONFIRMED: 'STEP_MINT_CONFIRMED',
  /** 12. STEP_HEDGE_AFTER_RESET_OK - Hedge adjusted after reset */
  HEDGE_AFTER_RESET: 'STEP_HEDGE_AFTER_RESET_OK',
  /** 13. STEP_LEDGER_RECORDED - Ledger recorded */
  LEDGER_RECORDED: 'STEP_LEDGER_RECORDED',
  /** 14. STEP_DONE - Operation complete */
  DONE: 'STEP_DONE',

  // Legacy mappings for backward compatibility
  /** @deprecated Use DECREASE_CONFIRMED */
  DECREASE_LIQUIDITY: 'STEP_DECREASE_CONFIRMED',
  /** @deprecated Use COLLECT_CONFIRMED */
  COLLECT_FEES: 'STEP_COLLECT_CONFIRMED',
  /** @deprecated Use BALANCES_SNAPSHOT */
  GET_BALANCES: 'STEP_BALANCES_SNAPSHOT',
  /** @deprecated Use SWAP_CONFIRMED or SWAP_SKIPPED */
  REBALANCE_50_50: 'STEP_SWAP_CONFIRMED',
  /** @deprecated Use ALLOWANCES_OK */
  ENSURE_ALLOWANCE_USDC: 'STEP_ALLOWANCES_OK',
  /** @deprecated Use ALLOWANCES_OK */
  ENSURE_ALLOWANCE_WETH: 'STEP_ALLOWANCES_OK',
  /** @deprecated Use MINT_CONFIRMED */
  MINT_NEW_POSITION: 'STEP_MINT_CONFIRMED',
  /** @deprecated Use HEDGE_AFTER_RESET */
  REHEDGE_AFTER_RESET: 'STEP_HEDGE_AFTER_RESET_OK',
  /** @deprecated Use LEDGER_RECORDED */
  RECORD_LEDGER: 'STEP_LEDGER_RECORDED',
  /** @deprecated Use DONE */
  UPDATE_ACTIVE_TOKEN: 'STEP_DONE',
  /** @deprecated Merged into other steps */
  COMPUTE_NEW_COMPOSITION: 'STEP_HEDGE_AFTER_RESET_OK',
  /** @deprecated Merged into other steps */
  COMPUTE_HEDGE_TARGET: 'STEP_HEDGE_AFTER_RESET_OK',
} as const;

/**
 * Steps for EMERGENCY_EXIT operation
 */
export const EMERGENCY_EXIT_STEPS = {
  /** Close hedge first (reduce-only) */
  CLOSE_HEDGE: 'close_hedge',
  /** Decrease LP liquidity */
  DECREASE_LIQUIDITY: 'decrease_liquidity',
  /** Collect tokens */
  COLLECT_FEES: 'collect_fees',
  /** Swap all to USDC */
  SWAP_TO_USDC: 'swap_to_usdc',
  /** Record in ledger */
  RECORD_LEDGER: 'record_ledger',
  /** Send critical alert */
  ALERT_CRITICAL: 'alert_critical',
} as const;
