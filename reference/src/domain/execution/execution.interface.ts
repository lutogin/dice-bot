import { ActionPlan } from '../strategy/strategy.types';
import { OpState } from '../state-store/state-store.types';
import {
  ExecutionResult,
  RehedgeParams,
  ResetRangeParams,
  EmergencyExitParams,
} from './execution.types';

/**
 * Execution Orchestrator interface
 *
 * Purpose: Execute ActionPlan safely in correct order with resume capability
 *
 * Dependencies:
 * - StateStore (begin/step/complete/resume)
 * - RiskManager (preflight/veto)
 * - LpPositionService (on-chain actions)
 * - WalletService (approvals, balances, rebalance 50/50)
 * - HedgeService (short position changes)
 * - StrategyEngine (recalculate target after reset)
 * - MonitoringService (alerts per step)
 * - LedgerService (record execution facts)
 */
export interface IExecutionOrchestrator {
  /**
   * Execute an action plan
   *
   * Dispatches to:
   * - NONE → return "nothing done"
   * - REHEDGE → executeRehedge
   * - RESET_RANGE → executeResetRange
   * - EMERGENCY_EXIT → executeEmergencyExit
   *
   * @param plan - Action plan from StrategyEngine
   * @returns Execution result
   */
  execute(plan: ActionPlan): Promise<ExecutionResult>;

  /**
   * Resume an in-flight operation from StateStore
   *
   * Important: Each step must be idempotent
   * (if tx already sent → don't send again, wait for receipt)
   *
   * @param opState - Operation state from StateStore
   * @returns Execution result
   */
  resume(opState: OpState): Promise<ExecutionResult>;

  /**
   * Execute rehedge operation
   *
   * Steps:
   * 1. beginOp(REHEDGE)
   * 2. HedgeService.setTargetShortNotional(target)
   * 3. LedgerService.record
   * 4. completeOp
   *
   * @param params - Rehedge parameters
   * @returns Execution result
   */
  executeRehedge(params: RehedgeParams): Promise<ExecutionResult>;

  /**
   * Execute LP range reset operation
   *
   * Steps (strict order):
   * 1. beginOp(RESET_RANGE)
   * 2. preflight: RiskManager.canExecuteReset (if not → abort + alert)
   * 3. LpPositionService.decreaseLiquidity(100%) → markStep(DECREASE_OK, txHash)
   * 4. LpPositionService.collectFees() → markStep(COLLECT_OK, txHash)
   * 5. WalletService.getBalances()
   * 6. WalletService.ensureAllowance(USDC/WETH, PositionManager)
   * 7. WalletService.rebalanceTo50_50(...) (if enabled) → markStep(REBALANCE_OK)
   * 8. LpPositionService.mintNewPosition(newTicks, amounts) → markStep(MINT_OK)
   * 9. Get new position composition
   * 10. targetShortUSDC = StrategyEngine.computeHedgeTarget(newLP)
   * 11. HedgeService.setTargetShortNotional(targetShortUSDC) → markStep(REHEDGE_AFTER_RESET_OK)
   * 12. LedgerService.recordReset
   * 13. completeOp
   *
   * @param params - Reset range parameters
   * @returns Execution result
   */
  executeResetRange(params: ResetRangeParams): Promise<ExecutionResult>;

  /**
   * Execute emergency exit operation
   *
   * Steps:
   * 1. beginOp(EMERGENCY_EXIT)
   * 2. HedgeService.reduceOnlyCloseAll()
   * 3. LpPositionService.decreaseLiquidity(100%)
   * 4. LpPositionService.collectFees()
   * 5. (optional) WalletService.swap everything to USDC
   * 6. LedgerService.recordEmergency
   * 7. alertCritical
   * 8. completeOp
   *
   * @param params - Emergency exit parameters
   * @returns Execution result
   */
  executeEmergencyExit(params: EmergencyExitParams): Promise<ExecutionResult>;

  /**
   * Check if there is an operation in progress
   */
  hasOperationInProgress(): Promise<boolean>;

  /**
   * Get current in-flight operation
   */
  getInFlightOperation(): Promise<OpState | null>;

  /**
   * Abort current operation (best effort)
   */
  abortOperation(): Promise<void>;

  /**
   * Check if currently executing
   */
  isExecuting(): boolean;
}
