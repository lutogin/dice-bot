import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { EventBus } from '../../infra/event-bus/event-bus';
import type { IStateStore } from '../state-store';
import type { IRiskManager } from '../risk';
import type { ILpPositionService } from '../lp-position';
import type { IWalletService } from '../wallet';
import type { IHedgeService } from '../hedge';
import { HedgeUrgency } from '../hedge';
import type { IStrategyEngine } from '../strategy';
import type { ITxPolicyService } from '../tx-policy';
import type { IMonitoringService } from '../monitoring';
import type { ILedgerService } from '../ledger';
import type { IDynamicThresholdService } from '../dynamic-threshold';
import {
  ActionPlan,
  ActionPlanType,
  LpCompositionInput,
} from '../strategy/strategy.types';
import {
  OpState,
  OpType,
  StepState,
  ResetRangeOpData,
  RESET_RANGE_STEP_ORDER,
  ResetRangeStep,
} from '../state-store/state-store.types';
import { IExecutionOrchestrator } from './execution.interface';
import {
  ExecutionResult,
  ExecutionStatus,
  RehedgeParams,
  ResetRangeParams,
  EmergencyExitParams,
  StepResult,
  REHEDGE_STEPS,
  EMERGENCY_EXIT_STEPS,
} from './execution.types';

/**
 * Execution Orchestrator
 * Executes ActionPlan safely with StateStore persistence and resume capability
 */
@injectable()
export class ExecutionOrchestrator implements IExecutionOrchestrator {
  private readonly logger: ILogger;
  private isCurrentlyExecuting: boolean = false;
  private abortRequested: boolean = false;

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE)
    private readonly configService: ConfigService,
    @inject(TOKENS.STATE_STORE) private readonly stateStore: IStateStore,
    @inject(TOKENS.RISK_MANAGER) private readonly riskManager: IRiskManager,
    @inject(TOKENS.LP_POSITION_SERVICE)
    private readonly lpService: ILpPositionService,
    @inject(TOKENS.WALLET_SERVICE)
    private readonly walletService: IWalletService,
    @inject(TOKENS.HEDGE_SERVICE) private readonly hedgeService: IHedgeService,
    @inject(TOKENS.STRATEGY_ENGINE)
    private readonly strategyEngine: IStrategyEngine,
    @inject(TOKENS.TX_POLICY_SERVICE)
    private readonly txPolicyService: ITxPolicyService,
    @inject(TOKENS.MONITORING_SERVICE)
    private readonly monitoringService: IMonitoringService,
    @inject(TOKENS.LEDGER_SERVICE)
    private readonly ledgerService: ILedgerService,
    @inject(TOKENS.EVENT_BUS) private readonly eventBus: EventBus,
    @inject(TOKENS.DYNAMIC_THRESHOLD_SERVICE)
    private readonly dynamicThresholdService: IDynamicThresholdService,
  ) {
    this.logger = logger.child(ExecutionOrchestrator.name);
    this.logger.info(`${ExecutionOrchestrator.name} initialized`);
  }

  // ==================== Abort Handling ====================

  /**
   * Check if abort was requested and throw if so
   * Call this at key checkpoints during long operations
   */
  private ensureNotAborted(operationId: string): void {
    if (this.abortRequested) {
      throw new Error(`Operation aborted by request: ${operationId}`);
    }
  }

  // ==================== Main Entry Points ====================

  /**
   * Execute an action plan
   *
   * Policy for in-flight operations:
   * - EMERGENCY_EXIT always takes priority - abort in-flight and execute emergency
   * - Other plans resume in-flight operation first
   */
  async execute(plan: ActionPlan): Promise<ExecutionResult> {
    const startedAt = Date.now();

    this.logger.info('Executing plan', {
      type: plan.type,
      isCritical: plan.isCritical,
    });

    // Check for existing in-flight operation
    const inFlight = await this.stateStore.getInFlightOp();
    if (inFlight) {
      // EMERGENCY_EXIT takes priority over any in-flight operation
      if (plan.type === 'EMERGENCY_EXIT') {
        this.logger.warn(
          'EMERGENCY_EXIT requested with in-flight operation - aborting in-flight',
          {
            inFlightOpId: inFlight.operationId,
            inFlightType: inFlight.type,
          },
        );

        // Fail the in-flight operation
        await this.stateStore.failOp(
          inFlight.operationId,
          'Aborted due to EMERGENCY_EXIT',
        );

        // Clear operation in progress flag
        this.riskManager.setOperationInProgress(false);

        // Proceed with emergency exit
        return this.executeEmergencyExit({
          reason: plan.summary || 'Emergency exit triggered by plan',
          triggerReasons: plan.emergencyReasons,
          swapToUsdc: true,
        });
      }

      // For non-emergency plans, resume in-flight operation
      this.logger.warn('Found in-flight operation, resuming instead', {
        operationId: inFlight.operationId,
        type: inFlight.type,
        newPlanType: plan.type,
      });
      return this.resume(inFlight);
    }

    // Dispatch based on plan type
    switch (plan.type) {
      case 'NONE':
        return this.createSkippedResult(startedAt, 'No action needed');

      case 'REHEDGE':
        if (!plan.rehedgeParams) {
          return this.createFailedResult(
            startedAt,
            'rehedge',
            'Missing rehedge parameters',
          );
        }
        return this.executeRehedge({
          targetShortUsdc: plan.rehedgeParams.targetShortUsdc,
          lpWethAmount: plan.rehedgeParams.lpWethAmount,
          mode: plan.rehedgeParams.mode,
          // Pass decision metrics for event reporting
          deltaDriftPercent: plan.rehedgeParams.deltaDriftPercent,
          effectiveThreshold: plan.rehedgeParams.effectiveThreshold,
          // Pass rehedge mode for cooldown tracking (gap_soft uses longer cooldown)
          rehedgeMode: plan.rehedgeParams.rehedgeMode,
          // Pass reason for telegram notification
          reason: plan.rehedgeParams.reason,
        });

      case 'RESET_RANGE':
        if (!plan.resetRangeParams) {
          return this.createFailedResult(
            startedAt,
            'reset_range',
            'Missing reset range parameters',
          );
        }
        return this.executeResetRange({
          // A0: Входные условия из StrategyEngine
          referencePrice: plan.referencePrice,
          newTickLower: plan.resetRangeParams.newTickLower,
          newTickUpper: plan.resetRangeParams.newTickUpper,
          oldTokenId: plan.resetRangeParams.oldTokenId,
          reason: plan.resetRangeParams.reason,
          rebalanceWallet:
            this.configService.rebalance?.rebalanceBeforeMint ?? true,
          maxSlippageBps: this.configService.swapPolicy?.maxSlippageBps,
          hedgeSafetyThresholdPercent: this.riskManager
            .getThresholds()
            .dangerLiquidationDistancePercent.toNumber(),
        });

      case 'EMERGENCY_EXIT':
        return this.executeEmergencyExit({
          reason: plan.summary || 'Emergency exit triggered by plan',
          triggerReasons: plan.emergencyReasons,
          swapToUsdc: true,
        });

      default:
        return this.createFailedResult(
          startedAt,
          'none',
          `Unknown plan type: ${plan.type}`,
        );
    }
  }

  /**
   * Resume an in-flight operation
   */
  async resume(opState: OpState): Promise<ExecutionResult> {
    const startedAt = Date.now();

    this.logger.info('Resuming operation', {
      operationId: opState.operationId,
      type: opState.type,
      status: opState.status,
      completedSteps: opState.steps
        .filter((s) => s.status === 'completed')
        .map((s) => s.stepName),
    });

    // Find last completed step
    const completedSteps = opState.steps.filter(
      (s) => s.status === 'completed',
    );
    const lastCompletedStep = completedSteps[completedSteps.length - 1];

    // Dispatch resume based on operation type
    switch (opState.type) {
      case 'rehedge':
        return this.resumeRehedge(opState, lastCompletedStep);

      case 'reset_range':
        return this.resumeResetRange(opState, lastCompletedStep);

      case 'emergency_exit':
        return this.resumeEmergencyExit(opState, lastCompletedStep);

      default:
        this.logger.error('Unknown operation type for resume', undefined, {
          type: opState.type,
        });
        await this.stateStore.failOp(
          opState.operationId,
          `Unknown operation type: ${opState.type}`,
        );
        return this.createFailedResult(
          startedAt,
          opState.type,
          `Unknown operation type: ${opState.type}`,
        );
    }
  }

  // ==================== Rehedge Execution ====================

  /**
   * Execute rehedge operation (per runbook B)
   *
   * B1. Preflight (Binance API ok, symbol available, minNotional check)
   * B2. Compute diff and action
   * B3-B4. Execute order (limit post-only → fallback IOC/market)
   * B5. Record ledger
   */
  async executeRehedge(params: RehedgeParams): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const txHashes: string[] = [];
    const orderIds: string[] = [];
    const stepsCompleted: string[] = [];
    const stepsFailed: string[] = [];

    this.isCurrentlyExecuting = true;
    this.abortRequested = false;

    let operationId: string | undefined = params.existingOperationId;

    try {
      // Step 1: Begin operation (or use existing for resume)
      if (!operationId) {
        const op = await this.stateStore.beginOp({
          type: 'rehedge',
          data: {
            targetShortUsdc: params.targetShortUsdc.toString(),
            lpWethAmount: params.lpWethAmount.toString(),
            mode: params.mode,
            // Store decision metrics for event reporting (especially for resume)
            deltaDriftPercent: params.deltaDriftPercent?.toString(),
            effectiveThreshold: params.effectiveThreshold?.toString(),
            // Store rehedge mode for cooldown tracking on resume
            rehedgeMode: params.rehedgeMode,
            // Store reason for telegram notification on resume
            reason: params.reason,
          },
          expectedSteps: Object.values(REHEDGE_STEPS),
        });
        operationId = op.operationId;

        this.logger.info('Started rehedge operation', {
          operationId,
          targetUsdc: params.targetShortUsdc.toFixed(2),
          rehedgeMode: params.rehedgeMode || 'normal',
        });
      } else {
        this.logger.info('Resuming rehedge operation', {
          operationId,
          targetUsdc: params.targetShortUsdc.toFixed(2),
        });
      }

      // ==================== B1: Preflight ====================
      await this.stateStore.markStepStarted(
        operationId,
        REHEDGE_STEPS.PREFLIGHT,
      );

      // Check Binance API ok
      const hedgeSnapshot = await this.hedgeService.getPosition();

      // Check if connected
      if (!(await this.hedgeService.isConnected())) {
        const reason = 'Rehedge blocked: Binance API not connected';
        await this.stateStore.markStepFailed(
          operationId,
          REHEDGE_STEPS.PREFLIGHT,
          reason,
        );
        stepsFailed.push(REHEDGE_STEPS.PREFLIGHT);

        await this.monitoringService.alertCritical(reason, {
          component: ExecutionOrchestrator.name,
        });

        await this.stateStore.failOp(operationId, reason);
        return this.createFailedResult(
          startedAt,
          'rehedge',
          reason,
          operationId,
          stepsCompleted,
          stepsFailed,
        );
      }

      // B2: Compute diff (check minNotional)
      const currentShortUsdc = hedgeSnapshot.shortNotionalUsdc;
      const diff = params.targetShortUsdc.sub(currentShortUsdc).abs();
      // Use strategy's minRehedgeAmountUsdc as primary, fallback to hedgeExchange config
      const minNotional = new Decimal(
        this.configService.strategy?.minRehedgeAmountUsdc ??
          this.configService.hedgeExchange.minTradeNotional ??
          10,
      );

      if (diff.lt(minNotional)) {
        // Diff too small, skip
        await this.stateStore.markStep(operationId, {
          stepName: REHEDGE_STEPS.PREFLIGHT,
          dataPatch: {
            skipped: true,
            reason: 'diff < minNotional',
            diff: diff.toString(),
            minNotional: minNotional.toString(),
          },
        });
        stepsCompleted.push(REHEDGE_STEPS.PREFLIGHT);

        await this.stateStore.completeOp(operationId);

        return {
          operationId,
          status: 'skipped',
          operationType: 'rehedge',
          startedAt,
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          stepsCompleted,
          stepsFailed,
          txHashes,
          orderIds,
          summary: `Rehedge skipped: diff ${diff.toFixed(2)} < minNotional ${minNotional.toFixed(2)}`,
        };
      }

      await this.stateStore.markStep(operationId, {
        stepName: REHEDGE_STEPS.PREFLIGHT,
        dataPatch: {
          currentShortUsdc: currentShortUsdc.toString(),
          targetShortUsdc: params.targetShortUsdc.toString(),
          diff: diff.toString(),
        },
      });
      stepsCompleted.push(REHEDGE_STEPS.PREFLIGHT);

      // Check for abort before CEX operation
      this.ensureNotAborted(operationId);

      // ==================== B3-B4: Set target short notional ====================
      await this.stateStore.markStepStarted(
        operationId,
        REHEDGE_STEPS.SET_TARGET,
      );

      // Map mode to urgency for new API
      const urgency =
        params.mode === 'iocMarket'
          ? HedgeUrgency.MARGIN_DANGER
          : HedgeUrgency.NORMAL;
      const hedgeResult = await this.hedgeService.setTargetShortNotional(
        params.targetShortUsdc,
        urgency,
      );

      // Check for abort after CEX operation
      this.ensureNotAborted(operationId);

      if (hedgeResult.orderIds?.length) {
        orderIds.push(...hedgeResult.orderIds);
      }

      const direction =
        hedgeResult.operation === 'increase' || hedgeResult.operation === 'open'
          ? 'increase'
          : 'decrease';

      await this.stateStore.markStep(operationId, {
        stepName: REHEDGE_STEPS.SET_TARGET,
        dataPatch: {
          executedAmount: hedgeResult.deltaUsdc.toString(),
          avgPrice: hedgeResult.avgExecutionPrice.toString(),
          fees: hedgeResult.feesUsdc.toString(),
          direction,
        },
      });
      stepsCompleted.push(REHEDGE_STEPS.SET_TARGET);

      // Step 3: Record in ledger
      await this.stateStore.markStepStarted(
        operationId,
        REHEDGE_STEPS.RECORD_LEDGER,
      );
      await this.ledgerService.recordHedgeFill({
        orderId: hedgeResult.orderIds[0] || `rehedge_${operationId}`,
        exchangeId: this.configService.hedgeExchange.id,
        symbol: this.configService.hedgeExchange.hedgeSymbol,
        side: direction === 'increase' ? 'sell' : 'buy',
        orderType: params.mode === 'iocMarket' ? 'market' : 'limit',
        filledAmount: hedgeResult.deltaEth.abs(),
        avgPrice: hedgeResult.avgExecutionPrice,
        feesUsdc: hedgeResult.feesUsdc,
      });

      await this.stateStore.markStep(operationId, {
        stepName: REHEDGE_STEPS.RECORD_LEDGER,
      });
      stepsCompleted.push(REHEDGE_STEPS.RECORD_LEDGER);

      // Step 4: Complete operation
      await this.stateStore.completeOp(operationId);

      // Record rehedge for cooldown and delta drift tracking
      // Pass mode for separate soft gap cooldown tracking
      this.riskManager.recordRehedge(params.lpWethAmount, params.rehedgeMode);

      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;

      // Get threshold info for event
      // Use effective threshold from decision if available, otherwise fallback to dynamic/static
      const effectiveThreshold =
        params.effectiveThreshold ||
        this.dynamicThresholdService.getThreshold();

      // Determine threshold source:
      // - 'decision' if threshold came from strategy decision (params)
      // - 'dynamic' if using dynamic threshold service
      // - 'static' if dynamic threshold is disabled
      const thresholdSource = params.effectiveThreshold
        ? 'decision'
        : this.dynamicThresholdService.isEnabled()
          ? 'dynamic'
          : 'static';

      // CRITICAL: Use delta drift percent from decision (correct LP delta drift metric)
      // Fallback calculates hedge adjustment ratio which is NOT the same as LP drift
      // This fallback should rarely be used - it's a safety net for legacy code paths
      const deltaDriftPercent = params.deltaDriftPercent;
      const hedgeAdjustmentPercent = hedgeResult.deltaUsdc
        .abs()
        .div(Decimal.max(params.targetShortUsdc, new Decimal(1)));

      // Emit rehedge.completed event
      this.eventBus.emit('rehedge.completed', {
        timestamp: completedAt,
        success: true,
        direction,
        deltaUsdc: hedgeResult.deltaUsdc.abs().toFixed(2),
        deltaEth: hedgeResult.deltaEth.abs().toFixed(6),
        newShortUsdc: hedgeResult.newShortNotionalUsdc.toFixed(2),
        targetUsdc: params.targetShortUsdc.toFixed(2),
        avgPrice: hedgeResult.avgExecutionPrice.toFixed(2),
        feesUsdc: hedgeResult.feesUsdc.toFixed(4),
        thresholdPercent: effectiveThreshold.mul(100).toFixed(2),
        thresholdSource,
        // LP delta drift % (from decision) - may be undefined for legacy paths
        deviationPercent: deltaDriftPercent
          ? deltaDriftPercent.mul(100).toFixed(2)
          : undefined,
        // Hedge adjustment as % of target (always available)
        hedgeAdjustmentPercent: hedgeAdjustmentPercent.mul(100).toFixed(2),
        durationMs,
        // Rehedge mode and reason for telegram notification
        rehedgeMode: params.rehedgeMode,
        reason: params.reason,
      });

      await this.monitoringService.alertInfo('Rehedge completed', {
        component: ExecutionOrchestrator.name,
      });

      return {
        operationId,
        status: 'success',
        operationType: 'rehedge',
        startedAt,
        completedAt,
        durationMs,
        stepsCompleted,
        stepsFailed,
        txHashes,
        orderIds,
        summary: `Rehedge to ${params.targetShortUsdc.toFixed(2)} USDC completed`,
        data: {
          targetUsdc: params.targetShortUsdc.toString(),
          executedUsdc: hedgeResult.deltaUsdc.toString(),
          avgPrice: hedgeResult.avgExecutionPrice.toString(),
        },
      };
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.logger.error('Rehedge failed', error as Error);

      if (operationId) {
        await this.stateStore.failOp(operationId, errorMsg);
      }

      await this.monitoringService.alertWarn('Rehedge failed', {
        component: ExecutionOrchestrator.name,
        error: errorMsg,
      });

      return this.createFailedResult(
        startedAt,
        'rehedge',
        errorMsg,
        operationId,
        stepsCompleted,
      );
    } finally {
      this.isCurrentlyExecuting = false;
    }
  }

  private async resumeRehedge(
    opState: OpState,
    lastStep?: StepState,
  ): Promise<ExecutionResult> {
    const params: RehedgeParams = {
      targetShortUsdc: new Decimal(opState.data.targetShortUsdc || '0'),
      lpWethAmount: new Decimal(opState.data.lpWethAmount || '0'),
      mode: opState.data.mode || 'makerPrefer',
      // Restore decision metrics from operation data
      deltaDriftPercent: opState.data.deltaDriftPercent
        ? new Decimal(opState.data.deltaDriftPercent)
        : undefined,
      effectiveThreshold: opState.data.effectiveThreshold
        ? new Decimal(opState.data.effectiveThreshold)
        : undefined,
      // CRITICAL: Pass existing operation ID to avoid creating new operation
      existingOperationId: opState.operationId,
      // Restore rehedge mode for cooldown tracking
      rehedgeMode: opState.data.rehedgeMode,
      // Restore reason for telegram notification
      reason: opState.data.reason,
    };

    // If SET_TARGET already done, just complete
    if (lastStep?.stepName === REHEDGE_STEPS.SET_TARGET) {
      // Continue from record ledger
      return this.continueRehedgeFromLedger(opState, params);
    }

    // Continue from the beginning with same operation ID
    return this.executeRehedge(params);
  }

  private async continueRehedgeFromLedger(
    opState: OpState,
    params: RehedgeParams,
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();

    try {
      // Record in ledger
      await this.stateStore.markStepStarted(
        opState.operationId,
        REHEDGE_STEPS.RECORD_LEDGER,
      );

      const setTargetStep = opState.steps.find(
        (s) => s.stepName === REHEDGE_STEPS.SET_TARGET,
      );
      const direction = setTargetStep?.data?.direction || 'increase';
      const executedAmountUsdc = new Decimal(
        setTargetStep?.data?.executedAmount || '0',
      );
      const avgPriceFromStep = new Decimal(
        setTargetStep?.data?.avgPrice || '0',
      );
      // Calculate filledAmount (ETH) safely - if avgPrice is 0, filledAmount is 0
      const filledAmountEth = avgPriceFromStep.gt(0)
        ? executedAmountUsdc.div(avgPriceFromStep)
        : new Decimal(0);

      await this.ledgerService.recordHedgeFill({
        orderId: `rehedge_${opState.operationId}`,
        exchangeId: this.configService.hedgeExchange.id,
        symbol: this.configService.hedgeExchange.hedgeSymbol,
        side: direction === 'increase' ? 'sell' : 'buy',
        orderType: params.mode === 'iocMarket' ? 'market' : 'limit',
        filledAmount: filledAmountEth,
        avgPrice: avgPriceFromStep,
        feesUsdc: new Decimal(setTargetStep?.data?.fees || '0'),
      });

      await this.stateStore.markStep(opState.operationId, {
        stepName: REHEDGE_STEPS.RECORD_LEDGER,
      });

      await this.stateStore.completeOp(opState.operationId);

      // Record rehedge for cooldown and delta drift tracking
      // Pass mode for separate soft gap cooldown tracking
      this.riskManager.recordRehedge(params.lpWethAmount, params.rehedgeMode);

      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;
      const feesUsdc = new Decimal(setTargetStep?.data?.fees || '0');

      // Get threshold info for event
      const effectiveThreshold =
        params.effectiveThreshold ||
        this.dynamicThresholdService.getThreshold();

      // Determine threshold source
      const thresholdSource = params.effectiveThreshold
        ? 'decision'
        : this.dynamicThresholdService.isEnabled()
          ? 'dynamic'
          : 'static';

      // LP delta drift % from decision (may be undefined for legacy paths)
      const deltaDriftPercent = params.deltaDriftPercent;
      const hedgeAdjustmentPercent = executedAmountUsdc
        .abs()
        .div(Decimal.max(params.targetShortUsdc, new Decimal(1)));

      // Emit rehedge.completed event
      this.eventBus.emit('rehedge.completed', {
        timestamp: completedAt,
        success: true,
        direction: direction as 'increase' | 'decrease',
        deltaUsdc: executedAmountUsdc.abs().toFixed(2),
        deltaEth: filledAmountEth.abs().toFixed(6),
        newShortUsdc: params.targetShortUsdc.toFixed(2),
        targetUsdc: params.targetShortUsdc.toFixed(2),
        avgPrice: avgPriceFromStep.toFixed(2),
        feesUsdc: feesUsdc.toFixed(4),
        thresholdPercent: effectiveThreshold.mul(100).toFixed(2),
        thresholdSource,
        deviationPercent: deltaDriftPercent
          ? deltaDriftPercent.mul(100).toFixed(2)
          : undefined,
        hedgeAdjustmentPercent: hedgeAdjustmentPercent.mul(100).toFixed(2),
        durationMs,
        // Rehedge mode and reason for telegram notification
        rehedgeMode: params.rehedgeMode,
        reason: params.reason,
      });

      return {
        operationId: opState.operationId,
        status: 'resumed',
        operationType: 'rehedge',
        startedAt,
        completedAt,
        durationMs,
        stepsCompleted: [REHEDGE_STEPS.SET_TARGET, REHEDGE_STEPS.RECORD_LEDGER],
        stepsFailed: [],
        txHashes: [],
        orderIds: [],
        summary: 'Resumed and completed rehedge',
      };
    } catch (error) {
      await this.stateStore.failOp(
        opState.operationId,
        (error as Error).message,
      );
      return this.createFailedResult(
        startedAt,
        'rehedge',
        (error as Error).message,
        opState.operationId,
      );
    }
  }

  // ==================== Reset Range Execution ====================

  /**
   * Execute LP range reset operation
   */
  async executeResetRange(params: ResetRangeParams): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const txHashes: string[] = [];
    const orderIds: string[] = [];
    const stepsCompleted: string[] = [];
    const stepsFailed: string[] = [];

    this.isCurrentlyExecuting = true;
    this.abortRequested = false;

    let operationId: string | undefined;

    try {
      const activeTokenIdBefore =
        params.oldTokenId || this.lpService.getTokenId() || 'unknown';

      const opData: ResetRangeOpData = {
        activeTokenIdBefore,
        newTicks: {
          newTickLower: params.newTickLower,
          newTickUpper: params.newTickUpper,
        },
        referencePrice: '0',
        tx: {},
        attempts: {
          swapAttempts: 0,
          mintAttempts: 0,
          hedgeAttempts: 0,
        },
        errors: [],
      };

      // Step 1: Begin operation
      const op = await this.stateStore.beginOp({
        type: 'reset_range',
        data: {
          ...opData,
          oldTokenId: params.oldTokenId,
          rebalanceWallet: params.rebalanceWallet,
        },
        expectedSteps: RESET_RANGE_STEP_ORDER,
      });
      operationId = op.operationId;

      this.logger.info('Started reset range operation', {
        operationId,
        newTickLower: params.newTickLower,
        newTickUpper: params.newTickUpper,
      });

      // Get reference price (from params or fetch)
      let referencePrice = params.referencePrice;
      if (!referencePrice) {
        const priceResult = await this.getPriceResult();
        referencePrice = priceResult.price;
      }
      await this.stateStore.updateResetRangeData(operationId, {
        referencePrice: referencePrice.toString(),
      });

      // ==================== A1: Preflight (жёсткий gate) ====================
      await this.stateStore.markStepStarted(
        operationId,
        ResetRangeStep.STEP_PREFLIGHT_OK,
      );

      const lpComposition = await this.getLpComposition(referencePrice);
      const hedgeSnapshot = await this.hedgeService.getPosition();

      // Save old position info for event
      const oldTickLower = lpComposition.tickLower;
      const oldTickUpper = lpComposition.tickUpper;
      const oldPriceLower = this.lpService.tickToPrice(oldTickLower);
      const oldPriceUpper = this.lpService.tickToPrice(oldTickUpper);

      const priceResultForRisk = await this.getPriceResult();
      const riskFlags = await this.riskManager.evaluate({
        priceResult: priceResultForRisk,
        lpComposition,
        hedgeSnapshot,
      });

      // A1 checks: Binance API ok, RPC ok, Price sanity ok, Margin safe >= 30%
      // NOTE: We check canExecuteReset BEFORE setting operationInProgress to avoid self-blocking
      if (!this.riskManager.canExecuteReset(riskFlags)) {
        const reason = `Reset blocked by risk: ${riskFlags.reasons.join(', ')}`;
        await this.stateStore.markStepFailed(
          operationId,
          ResetRangeStep.STEP_PREFLIGHT_OK,
          reason,
        );
        stepsFailed.push(ResetRangeStep.STEP_PREFLIGHT_OK);

        await this.monitoringService.alertCritical(
          'Reset blocked by RiskManager',
          {
            component: ExecutionOrchestrator.name,
            error: reason,
            reason: params.reason,
          },
        );

        await this.stateStore.failOp(operationId, reason);
        return this.createFailedResult(
          startedAt,
          'reset_range',
          reason,
          operationId,
          stepsCompleted,
          stepsFailed,
        );
      }

      // Mark operation in progress for risk manager AFTER preflight passes
      // This prevents the operation from blocking itself
      this.riskManager.setOperationInProgress(true);

      await this.stateStore.markStep(operationId, {
        stepName: ResetRangeStep.STEP_PREFLIGHT_OK,
        dataPatch: {
          passed: true,
          referencePrice: referencePrice.toString(),
          riskFlags: {
            cexDown: riskFlags.cexDown,
            rpcDown: riskFlags.rpcDown,
            priceAnomaly: riskFlags.priceAnomaly,
            marginDanger: riskFlags.marginDanger,
          },
        },
      });
      stepsCompleted.push(ResetRangeStep.STEP_PREFLIGHT_OK);

      // ==================== A2: Hedge Safety ====================
      // If distance_to_liq < 35%, reduce short to safe level first
      await this.stateStore.markStepStarted(
        operationId,
        ResetRangeStep.STEP_HEDGE_SAFETY_OK,
      );

      const hedgeSafetyThreshold =
        params.hedgeSafetyThresholdPercent ||
        this.riskManager
          .getThresholds()
          .dangerLiquidationDistancePercent.toNumber();
      let hedgeSafetyResult: { reduced: boolean; newLiqDistance?: Decimal } = {
        reduced: false,
      };

      if (
        hedgeSnapshot.hasPosition &&
        hedgeSnapshot.liquidationDistancePercent.lessThan(hedgeSafetyThreshold)
      ) {
        this.logger.warn('Hedge safety: reducing short before reset', {
          currentLiqDistance:
            hedgeSnapshot.liquidationDistancePercent.toFixed(2),
          threshold: hedgeSafetyThreshold,
        });

        // Reduce short to increase margin safety
        // Target: reduce by 20% to get more breathing room
        const currentShort = hedgeSnapshot.shortNotionalUsdc;
        const reducedTarget = currentShort.mul(0.8);

        // Hedge safety - use MARGIN_DANGER for immediate execution
        const reduceResult = await this.hedgeService.setTargetShortNotional(
          reducedTarget,
          HedgeUrgency.MARGIN_DANGER,
        );
        if (reduceResult.orderIds?.length)
          orderIds.push(...reduceResult.orderIds);

        // Re-check hedge snapshot
        const newHedgeSnapshot = await this.hedgeService.getPosition();
        hedgeSafetyResult = {
          reduced: true,
          newLiqDistance: newHedgeSnapshot.liquidationDistancePercent,
        };
      }

      await this.stateStore.markStep(operationId, {
        stepName: ResetRangeStep.STEP_HEDGE_SAFETY_OK,
        dataPatch: {
          reduced: hedgeSafetyResult.reduced,
          newLiqDistance: hedgeSafetyResult.newLiqDistance?.toString(),
        },
      });
      stepsCompleted.push(ResetRangeStep.STEP_HEDGE_SAFETY_OK);

      // Set token ID if provided
      if (params.oldTokenId) {
        this.lpService.setTokenId(params.oldTokenId);
      }

      // Step 3: Decrease liquidity 100%
      await this.stateStore.markStepStarted(
        operationId,
        ResetRangeStep.STEP_DECREASE_SENT,
      );
      const decreaseResult = await this.lpService.decreaseLiquidity({
        percent: 100,
      });
      if (decreaseResult.txHash) txHashes.push(decreaseResult.txHash);

      await this.stateStore.markStep(operationId, {
        stepName: ResetRangeStep.STEP_DECREASE_SENT,
        txHash: decreaseResult.txHash,
        dataPatch: {
          amount0: decreaseResult.amount0?.toString(),
          amount1: decreaseResult.amount1?.toString(),
        },
      });
      stepsCompleted.push(ResetRangeStep.STEP_DECREASE_SENT);

      await this.confirmTxStep(
        operationId,
        ResetRangeStep.STEP_DECREASE_CONFIRMED,
        decreaseResult.txHash,
        stepsCompleted,
      );

      if (decreaseResult.txHash) {
        await this.stateStore.updateResetRangeData(operationId, {
          tx: { decreaseTxHash: decreaseResult.txHash },
        });
      }

      // Clear activeTokenId after LP is closed (before new mint)
      // This prevents bot from using closed/empty LP on restart
      await this.stateStore.clearActiveTokenId(
        'LP decreased to 0% during reset',
        operationId,
      );

      // Step 4: Collect fees
      await this.stateStore.markStepStarted(
        operationId,
        ResetRangeStep.STEP_COLLECT_SENT,
      );
      const collectResult = await this.lpService.collectFees();
      if (collectResult.txHash) txHashes.push(collectResult.txHash);

      // Save collected fees for event (amount0 = WETH, amount1 = USDC for typical pool)
      const collectedWeth = collectResult.amount0;
      const collectedUsdc = collectResult.amount1;

      await this.stateStore.markStep(operationId, {
        stepName: ResetRangeStep.STEP_COLLECT_SENT,
        txHash: collectResult.txHash,
        dataPatch: {
          amount0: collectResult.amount0.toString(),
          amount1: collectResult.amount1.toString(),
        },
      });
      stepsCompleted.push(ResetRangeStep.STEP_COLLECT_SENT);

      await this.confirmTxStep(
        operationId,
        ResetRangeStep.STEP_COLLECT_CONFIRMED,
        collectResult.txHash,
        stepsCompleted,
      );

      if (collectResult.txHash) {
        await this.stateStore.updateResetRangeData(operationId, {
          tx: { collectTxHash: collectResult.txHash },
        });
      }

      // Record fee collection
      await this.ledgerService.recordUniFee({
        tokenId: params.oldTokenId || this.lpService.getTokenId() || 'unknown',
        txHash: collectResult.txHash,
        amount0: collectResult.amount0,
        amount1: collectResult.amount1,
        priceUsdc: referencePrice,
      });

      // ==================== A5: Get balances and compute 50/50 need ====================
      await this.stateStore.markStepStarted(
        operationId,
        ResetRangeStep.STEP_BALANCES_SNAPSHOT,
      );
      const balances =
        await this.walletService.getBalancesWithValue(referencePrice);
      const totalValueUsdc =
        balances.totalValueUsdc ||
        balances.weth.mul(referencePrice).add(balances.usdc);

      await this.stateStore.markStep(operationId, {
        stepName: ResetRangeStep.STEP_BALANCES_SNAPSHOT,
        dataPatch: {
          weth: balances.weth.toString(),
          usdc: balances.usdc.toString(),
          totalUsdc: totalValueUsdc.toString(),
        },
      });
      stepsCompleted.push(ResetRangeStep.STEP_BALANCES_SNAPSHOT);

      // Compute whether 50/50 rebalance is needed (per A5)
      const wethValue = balances.weth.mul(referencePrice);
      const totalValueComputed = balances.usdc.add(wethValue);
      const targetHalf = totalValueComputed.div(2);
      const imbalancePercent = wethValue
        .sub(targetHalf)
        .abs()
        .div(totalValueComputed)
        .mul(100);
      const swapPolicy = this.configService.swapPolicy || {
        deviationThresholdPct: 0.002,
        maxSlippageBps: 30,
        deadlineSec: 120,
        minNotionalUsdc: 200,
      };
      const rebalanceConfig = this.configService.rebalance;
      const imbalanceThresholdPct =
        rebalanceConfig?.rebalanceImbalanceThresholdPct ?? 5;
      const needRebalance = imbalancePercent.gt(imbalanceThresholdPct);

      // ==================== A6: Rebalance to 50/50 (before allowances!) ====================
      let amountWeth = balances.weth;
      let amountUsdc = balances.usdc;

      if (params.rebalanceWallet && needRebalance) {
        await this.stateStore.markStepStarted(
          operationId,
          ResetRangeStep.STEP_SWAP_SENT,
        );

        // Per spec section 5: Check if swap is allowed BEFORE executing
        // Re-evaluate risk flags (prices might have changed during decrease/collect)
        const currentPriceResult = await this.getPriceResult();
        const currentRiskFlags = await this.riskManager.evaluate({
          priceResult: currentPriceResult,
          lpComposition, // LP composition from before (position is now 0)
          hedgeSnapshot: await this.hedgeService.getPosition(),
        });

        if (!this.riskManager.canSwap(currentRiskFlags)) {
          // Swap blocked - abort reset, stay in wallet (USDC/WETH)
          const reason = `Swap blocked by RiskManager: ${currentRiskFlags.reasons.join(', ')}. Staying in wallet.`;
          await this.stateStore.markStepFailed(
            operationId,
            ResetRangeStep.STEP_SWAP_SENT,
            reason,
          );
          stepsFailed.push(ResetRangeStep.STEP_SWAP_SENT);

          await this.monitoringService.alertCritical(
            'Reset aborted: swap conditions unsafe',
            {
              component: ExecutionOrchestrator.name,
              error: reason,
              priceAnomaly: currentRiskFlags.priceAnomaly,
              rpcDown: currentRiskFlags.rpcDown,
            },
          );

          await this.stateStore.failOp(operationId, reason);
          this.riskManager.setOperationInProgress(false);
          return this.createFailedResult(
            startedAt,
            'reset_range',
            reason,
            operationId,
            stepsCompleted,
            stepsFailed,
          );
        }

        const maxSlippageBps =
          params.maxSlippageBps ?? swapPolicy.maxSlippageBps;
        const deadlineSec = swapPolicy.deadlineSec;
        const minNotionalUsdc = swapPolicy.minNotionalUsdc;

        // Calculate optimal WETH/USDC ratio for the new range
        // This is critical for minimizing leftover after mint
        const { wethPercent: targetWethPercent } =
          await this.lpService.calculateOptimalRatioForRange(
            params.newTickLower,
            params.newTickUpper,
          );

        this.logger.info('Calculated optimal ratio for new range', {
          newTickLower: params.newTickLower,
          newTickUpper: params.newTickUpper,
          targetWethPercent: targetWethPercent.toFixed(1) + '%',
        });

        // Execute rebalance to optimal ratio (not 50/50!)
        const rebalanceResult = await this.walletService.rebalanceTo50_50({
          referencePrice,
          deviationThresholdPct: swapPolicy.deviationThresholdPct,
          maxSlippageBps,
          deadlineSec,
          minNotionalUsdc,
          dryRun: false,
          targetWethPercent: targetWethPercent.toNumber(),
        });

        // Check if rebalance failed
        if (!rebalanceResult.success) {
          const reason = `Rebalance swap failed: ${rebalanceResult.error || 'unknown error'}. Aborting reset.`;
          await this.stateStore.markStepFailed(
            operationId,
            ResetRangeStep.STEP_SWAP_SENT,
            reason,
          );
          stepsFailed.push(ResetRangeStep.STEP_SWAP_SENT);

          await this.monitoringService.alertCritical(
            'Reset aborted: 50/50 rebalance failed',
            {
              component: ExecutionOrchestrator.name,
              error: reason,
            },
          );

          await this.stateStore.failOp(operationId, reason);
          this.riskManager.setOperationInProgress(false);
          return this.createFailedResult(
            startedAt,
            'reset_range',
            reason,
            operationId,
            stepsCompleted,
            stepsFailed,
          );
        }

        // Get tx hash from result
        const swapTxHash = rebalanceResult.txHash;
        if (swapTxHash) txHashes.push(swapTxHash);

        // Get final balances from result or re-fetch
        if (rebalanceResult.balancesAfter) {
          amountWeth = rebalanceResult.balancesAfter.weth;
          amountUsdc = rebalanceResult.balancesAfter.usdc;
        }

        await this.stateStore.markStep(operationId, {
          stepName: ResetRangeStep.STEP_SWAP_SENT,
          txHash: swapTxHash,
          dataPatch: {
            performed: rebalanceResult.performed,
            direction: rebalanceResult.direction,
            imbalancePercent: imbalancePercent.toFixed(2),
            deviationBefore: rebalanceResult.deviationPercentBefore?.toFixed(2),
            reason: rebalanceResult.reason,
            finalWeth: amountWeth.toString(),
            finalUsdc: amountUsdc.toString(),
            amountIn: rebalanceResult.amountIn?.toString(),
            amountOutMin: rebalanceResult.amountOutMin?.toString(),
          },
        });
        stepsCompleted.push(ResetRangeStep.STEP_SWAP_SENT);

        await this.confirmTxStep(
          operationId,
          ResetRangeStep.STEP_SWAP_CONFIRMED,
          swapTxHash,
          stepsCompleted,
        );

        if (swapTxHash) {
          await this.stateStore.updateResetRangeData(operationId, {
            tx: { swapTxHash },
            swap: {
              performed: rebalanceResult.performed,
              direction:
                rebalanceResult.direction === 'NONE'
                  ? undefined
                  : rebalanceResult.direction,
              amountIn: rebalanceResult.amountIn?.toString(),
              amountOutMin: rebalanceResult.amountOutMin?.toString(),
              amountOut: rebalanceResult.amountOut?.toString(),
            },
          });
        }

        // Record swap if performed
        if (rebalanceResult.performed && swapTxHash) {
          await this.ledgerService.recordDexTx({
            txHash: swapTxHash,
            type: 'swap',
            gasUsed: rebalanceResult.swap?.gasUsed || new Decimal(0),
            priceUsdc: referencePrice,
          });
        }
      } else if (!needRebalance) {
        // Skip rebalance, mark as completed anyway
        await this.stateStore.markStep(operationId, {
          stepName: ResetRangeStep.STEP_SWAP_SKIPPED,
          dataPatch: {
            skipped: true,
            imbalancePercent: imbalancePercent.toFixed(2),
          },
        });
        stepsCompleted.push(ResetRangeStep.STEP_SWAP_SKIPPED);
      }

      // ==================== A7: Approvals ====================
      const positionManager = this.configService.web3.positionManagerAddress;

      await this.stateStore.markStepStarted(
        operationId,
        ResetRangeStep.STEP_ALLOWANCES_OK,
      );
      const usdcAllowance = await this.walletService.ensureAllowance(
        this.configService.pool.token1Address, // USDC
        positionManager,
        amountUsdc,
      );
      if (!usdcAllowance.ok) {
        throw new Error(
          `USDC approval failed: ${usdcAllowance.error || 'unknown error'}`,
        );
      }
      if (usdcAllowance.txHash) txHashes.push(usdcAllowance.txHash);
      const wethAllowance = await this.walletService.ensureAllowance(
        this.configService.pool.token0Address, // WETH
        positionManager,
        amountWeth,
      );
      if (!wethAllowance.ok) {
        throw new Error(
          `WETH approval failed: ${wethAllowance.error || 'unknown error'}`,
        );
      }
      if (wethAllowance.txHash) txHashes.push(wethAllowance.txHash);

      if (!this.configService.isSimulationMode()) {
        if (usdcAllowance.txHash) {
          await this.txPolicyService.waitConfirmed(usdcAllowance.txHash);
        }
        if (wethAllowance.txHash) {
          await this.txPolicyService.waitConfirmed(wethAllowance.txHash);
        }
      }

      await this.stateStore.markStep(operationId, {
        stepName: ResetRangeStep.STEP_ALLOWANCES_OK,
        txHash: wethAllowance.txHash || usdcAllowance.txHash,
        dataPatch: {
          usdcAllowanceTx: usdcAllowance.txHash,
          wethAllowanceTx: wethAllowance.txHash,
        },
      });
      stepsCompleted.push(ResetRangeStep.STEP_ALLOWANCES_OK);

      // ==================== A8: Mint new NFT using mintNewPositionForBudget ====================
      // This method handles amount selection, buffers, and approvals internally

      // Safety check: verify wallet has sufficient balance before minting
      const preMintBalances = await this.walletService.getBalances();
      const preMintWethValue = preMintBalances.weth.mul(referencePrice);
      const preMintTotalAvailable = preMintBalances.usdc.add(preMintWethValue);
      const MIN_MINT_VALUE_USDC = new Decimal(50); // Minimum $50 to create LP

      if (preMintTotalAvailable.lt(MIN_MINT_VALUE_USDC)) {
        const reason = `Insufficient balance for mint: $${preMintTotalAvailable.toFixed(2)} < $${MIN_MINT_VALUE_USDC}. Check swap step or wallet.`;
        this.logger.error('Reset aborted: insufficient balance', undefined, {
          totalAvailable: preMintTotalAvailable.toFixed(2),
          minRequired: MIN_MINT_VALUE_USDC.toString(),
          weth: preMintBalances.weth.toFixed(6),
          usdc: preMintBalances.usdc.toFixed(2),
        });

        await this.stateStore.failOp(operationId, reason);
        this.riskManager.setOperationInProgress(false);
        return this.createFailedResult(
          startedAt,
          'reset_range',
          reason,
          operationId,
          stepsCompleted,
          stepsFailed,
        );
      }

      await this.stateStore.markStepStarted(
        operationId,
        ResetRangeStep.STEP_MINT_SENT,
      );

      // Use the new budget-aware mint method
      // Note: approvals above are redundant now since mintNewPositionForBudget handles them,
      // but we keep them as explicit steps for StateStore tracking
      const mintResult = await this.lpService.mintNewPositionForBudget({
        tickLower: params.newTickLower,
        tickUpper: params.newTickUpper,
        referencePrice,
        // Budget policy from config (or use defaults)
        budgetPolicy: this.configService.mintPolicy
          ? {
              useAllBalances: this.configService.mintPolicy.useAllBalances,
              reserveEthForGas: new Decimal(
                this.configService.mintPolicy.reserveEthForGas,
              ),
              amountSafetyPct: new Decimal(
                this.configService.mintPolicy.amountSafetyPct,
              ),
              amount0MinPct: new Decimal(
                this.configService.mintPolicy.amount0MinPct,
              ),
              amount1MinPct: new Decimal(
                this.configService.mintPolicy.amount1MinPct,
              ),
              deadlineSec: this.configService.mintPolicy.deadlineSec,
              maxLeftoverPctWarn: new Decimal(
                this.configService.mintPolicy.maxLeftoverPctWarn,
              ),
            }
          : undefined,
      });

      if (!mintResult.success) {
        const reason = `Mint failed: ${mintResult.error || mintResult.reason}`;
        await this.stateStore.markStepFailed(
          operationId,
          ResetRangeStep.STEP_MINT_SENT,
          reason,
        );
        stepsFailed.push(ResetRangeStep.STEP_MINT_SENT);

        await this.monitoringService.alertCritical(
          'Reset aborted: mint failed',
          {
            component: ExecutionOrchestrator.name,
            error: reason,
          },
        );

        await this.stateStore.failOp(operationId, reason);
        this.riskManager.setOperationInProgress(false);
        return this.createFailedResult(
          startedAt,
          'reset_range',
          reason,
          operationId,
          stepsCompleted,
          stepsFailed,
        );
      }

      if (mintResult.txHash) txHashes.push(mintResult.txHash);

      await this.stateStore.markStep(operationId, {
        stepName: ResetRangeStep.STEP_MINT_SENT,
        txHash: mintResult.txHash,
        dataPatch: {
          newTokenId: mintResult.newTokenId,
          tickLower: params.newTickLower,
          tickUpper: params.newTickUpper,
          usedWeth: mintResult.usedWeth.toString(),
          usedUsdc: mintResult.usedUsdc.toString(),
          leftoverWeth: mintResult.leftoverWeth.toString(),
          leftoverUsdc: mintResult.leftoverUsdc.toString(),
          leftoverPct: mintResult.leftoverPct.mul(100).toFixed(2) + '%',
        },
      });
      stepsCompleted.push(ResetRangeStep.STEP_MINT_SENT);

      if (mintResult.newTokenId) {
        this.lpService.setTokenId(mintResult.newTokenId);
      }

      await this.confirmTxStep(
        operationId,
        ResetRangeStep.STEP_MINT_CONFIRMED,
        mintResult.txHash,
        stepsCompleted,
        { newTokenId: mintResult.newTokenId },
      );

      await this.stateStore.updateResetRangeData(operationId, {
        tx: { mintTxHash: mintResult.txHash },
        mint: { newTokenId: mintResult.newTokenId },
      });

      // Record mint tx
      await this.ledgerService.recordDexTx({
        txHash: mintResult.txHash || '',
        type: 'mint',
        gasUsed: new Decimal(0), // Would need to get from receipt
        priceUsdc: referencePrice,
      });

      // ==================== A9: Compute new LP composition and rehedge ====================
      const newComposition =
        await this.lpService.getComposition(referencePrice);

      const lpCompositionInput: LpCompositionInput = {
        wethAmount: newComposition.wethAmount,
        usdcAmount: newComposition.usdcAmount,
        totalValueUsdc: newComposition.totalValueUsdc,
        inRange: newComposition.inRange,
        currentTick: newComposition.currentTick,
        tickLower: params.newTickLower,
        tickUpper: params.newTickUpper,
        distanceToLowerPercent: newComposition.distanceToLowerPercent,
        distanceToUpperPercent: newComposition.distanceToUpperPercent,
      };

      const targetShortUsdc = this.strategyEngine.computeHedgeTarget(
        lpCompositionInput,
        referencePrice,
      );

      // Step 11: Rehedge after reset - use POST_RESET urgency
      await this.stateStore.markStepStarted(
        operationId,
        ResetRangeStep.STEP_HEDGE_AFTER_RESET_OK,
      );

      const rehedgeResult = await this.hedgeService.setTargetShortNotional(
        targetShortUsdc,
        HedgeUrgency.POST_RESET,
      );
      if (rehedgeResult.orderIds?.length)
        orderIds.push(...rehedgeResult.orderIds);

      const rehedgeDirection =
        rehedgeResult.operation === 'increase' ||
        rehedgeResult.operation === 'open'
          ? 'increase'
          : 'decrease';

      await this.stateStore.markStep(operationId, {
        stepName: ResetRangeStep.STEP_HEDGE_AFTER_RESET_OK,
        dataPatch: {
          wethAmount: newComposition.wethAmount.toString(),
          usdcAmount: newComposition.usdcAmount.toString(),
          totalValueUsdc: newComposition.totalValueUsdc.toString(),
          targetShortUsdc: targetShortUsdc.toString(),
          executedAmount: rehedgeResult.deltaUsdc.toString(),
          avgPrice: rehedgeResult.avgExecutionPrice.toString(),
          direction: rehedgeDirection,
        },
      });
      stepsCompleted.push(ResetRangeStep.STEP_HEDGE_AFTER_RESET_OK);

      // Record hedge fill (for any non-zero trade, including decreases)
      if (rehedgeResult.deltaUsdc.abs().gt(0)) {
        await this.ledgerService.recordHedgeFill({
          orderId:
            rehedgeResult.orderIds?.[0] || `rehedge_after_reset_${operationId}`,
          exchangeId: this.configService.hedgeExchange.id,
          symbol: this.configService.hedgeExchange.hedgeSymbol,
          side: rehedgeDirection === 'increase' ? 'sell' : 'buy',
          orderType: 'limit',
          filledAmount: rehedgeResult.deltaEth.abs(),
          avgPrice: rehedgeResult.avgExecutionPrice,
          feesUsdc: rehedgeResult.feesUsdc,
        });
      }

      // Step 12: Record in ledger
      await this.stateStore.markStepStarted(
        operationId,
        ResetRangeStep.STEP_LEDGER_RECORDED,
      );

      // Record tick snapshot
      const finalHedge = await this.hedgeService.getPosition();
      const finalWalletBalances =
        await this.walletService.getBalancesWithValue(referencePrice);
      const walletEthValueUsdc =
        finalWalletBalances.ethForGas.mul(referencePrice);
      await this.ledgerService.recordTick({
        prices: {
          cexPrice: referencePrice,
          dexPrice: referencePrice,
          referencePrice,
        },
        lp: {
          tokenId: mintResult.newTokenId,
          inRange: newComposition.inRange,
          wethAmount: newComposition.wethAmount,
          usdcAmount: newComposition.usdcAmount,
          totalValueUsdc: newComposition.totalValueUsdc,
          tickLower: params.newTickLower,
          tickUpper: params.newTickUpper,
          currentTick: newComposition.currentTick,
        },
        wallet: {
          usdc: finalWalletBalances.usdc,
          weth: finalWalletBalances.weth,
          ethForGas: finalWalletBalances.ethForGas,
          totalValueUsdc: finalWalletBalances.totalValueUsdc || new Decimal(0),
          wethValueUsdc: finalWalletBalances.wethValueUsdc || new Decimal(0),
          ethValueUsdc: walletEthValueUsdc,
        },
        hedge: {
          hasPosition: finalHedge.hasPosition,
          shortSizeEth: finalHedge.shortSizeEth,
          shortNotionalUsdc: finalHedge.shortNotionalUsdc,
          unrealizedPnl: finalHedge.unrealizedPnl,
          equity: finalHedge.equity,
          liquidationDistancePercent: finalHedge.liquidationDistancePercent,
        },
      });

      await this.stateStore.markStep(operationId, {
        stepName: ResetRangeStep.STEP_LEDGER_RECORDED,
      });
      stepsCompleted.push(ResetRangeStep.STEP_LEDGER_RECORDED);

      // ==================== Update active token ID (per runbook C) ====================
      await this.stateStore.markStepStarted(
        operationId,
        ResetRangeStep.STEP_DONE,
      );

      if (mintResult.newTokenId) {
        // Update LpPositionService
        this.lpService.setTokenId(mintResult.newTokenId);
        await this.riskManager.recordReset();
      }

      await this.stateStore.markStep(operationId, {
        stepName: ResetRangeStep.STEP_DONE,
        dataPatch: {
          newTokenId: mintResult.newTokenId,
          oldTokenId: params.oldTokenId,
        },
      });
      stepsCompleted.push(ResetRangeStep.STEP_DONE);

      // ==================== A10: Complete operation ====================
      if (mintResult.newTokenId) {
        await this.stateStore.completeReset(
          operationId,
          mintResult.newTokenId,
          newComposition.wethAmount.toString(),
          {
            txHash: mintResult.txHash,
            sourceOpId: operationId,
          },
        );
      } else {
        await this.stateStore.completeOp(operationId);
      }
      this.riskManager.setOperationInProgress(false);

      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;

      // Calculate new price bounds
      const newPriceLower = this.lpService.tickToPrice(params.newTickLower);
      const newPriceUpper = this.lpService.tickToPrice(params.newTickUpper);

      // Emit reset.completed event
      this.eventBus.emit('reset.completed', {
        timestamp: completedAt,
        success: true,
        oldTokenId: params.oldTokenId || activeTokenIdBefore,
        newTokenId: mintResult.newTokenId || 'unknown',
        oldTickLower,
        oldTickUpper,
        newTickLower: params.newTickLower,
        newTickUpper: params.newTickUpper,
        oldPriceLower: oldPriceLower.toFixed(2),
        oldPriceUpper: oldPriceUpper.toFixed(2),
        newPriceLower: newPriceLower.toFixed(2),
        newPriceUpper: newPriceUpper.toFixed(2),
        referencePrice: referencePrice.toFixed(2),
        newTotalValueUsdc: newComposition.totalValueUsdc.toFixed(2),
        collectedWeth: collectedWeth.toFixed(6),
        collectedUsdc: collectedUsdc.toFixed(2),
        durationMs,
        reason: params.reason,
      });

      await this.monitoringService.alertInfo('Range reset completed', {
        component: ExecutionOrchestrator.name,
        newTokenId: mintResult.newTokenId,
        oldTokenId: params.oldTokenId,
      });

      return {
        operationId,
        status: 'success',
        operationType: 'reset_range',
        startedAt,
        completedAt,
        durationMs,
        stepsCompleted,
        stepsFailed,
        txHashes,
        orderIds,
        summary: `Range reset to [${params.newTickLower}, ${params.newTickUpper}] completed`,
        data: {
          newTokenId: mintResult.newTokenId,
          newTickLower: params.newTickLower,
          newTickUpper: params.newTickUpper,
          newTotalValueUsdc: newComposition.totalValueUsdc.toString(),
          targetShortUsdc: targetShortUsdc.toString(),
        },
      };
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.logger.error('Reset range failed', error as Error);

      if (operationId) {
        await this.stateStore.failOp(operationId, errorMsg);
      }

      this.riskManager.setOperationInProgress(false);

      await this.monitoringService.alertCritical('Range reset failed', {
        component: ExecutionOrchestrator.name,
        error: errorMsg,
      });

      return this.createFailedResult(
        startedAt,
        'reset_range',
        errorMsg,
        operationId,
        stepsCompleted,
        stepsFailed,
      );
    } finally {
      this.isCurrentlyExecuting = false;
    }
  }

  private async resumeResetRange(
    opState: OpState,
    lastStep?: StepState,
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const txHashes: string[] = [];
    const orderIds: string[] = [];
    const stepsCompleted: string[] = [];
    const stepsFailed: string[] = [];

    this.isCurrentlyExecuting = true;
    this.abortRequested = false;
    // NOTE: Don't set operationInProgress here - we set it after preflight passes
    // to avoid self-blocking if preflight needs to run

    try {
      const pendingTxs = [
        {
          sent: ResetRangeStep.STEP_DECREASE_SENT,
          confirmed: ResetRangeStep.STEP_DECREASE_CONFIRMED,
        },
        {
          sent: ResetRangeStep.STEP_COLLECT_SENT,
          confirmed: ResetRangeStep.STEP_COLLECT_CONFIRMED,
        },
        {
          sent: ResetRangeStep.STEP_SWAP_SENT,
          confirmed: ResetRangeStep.STEP_SWAP_CONFIRMED,
        },
        {
          sent: ResetRangeStep.STEP_MINT_SENT,
          confirmed: ResetRangeStep.STEP_MINT_CONFIRMED,
        },
      ]
        .map(({ sent, confirmed }) => {
          const step = this.getStepState(opState, sent);
          if (!step?.txHash || step.status !== 'completed') return null;
          if (this.isStepCompleted(opState, confirmed)) return null;
          return { step: sent, txHash: step.txHash };
        })
        .filter(Boolean) as Array<{ step: string; txHash: string }>;

      if (pendingTxs.length > 0) {
        this.logger.info('Resume reset-range with pending txs', {
          operationId: opState.operationId,
          pendingTxs,
        });
      }

      const opData = opState.data as ResetRangeOpData & {
        oldTokenId?: string;
        rebalanceWallet?: boolean;
        newTickLower?: number;
        newTickUpper?: number;
      };

      const newTickLower = opData.newTicks?.newTickLower ?? opData.newTickLower;
      const newTickUpper = opData.newTicks?.newTickUpper ?? opData.newTickUpper;

      if (newTickLower === undefined || newTickUpper === undefined) {
        const reason = 'Resume failed: missing new tick bounds in op state';
        await this.stateStore.failOp(opState.operationId, reason);
        return this.createFailedResult(
          startedAt,
          'reset_range',
          reason,
          opState.operationId,
          stepsCompleted,
          stepsFailed,
        );
      }

      const params: ResetRangeParams = {
        newTickLower,
        newTickUpper,
        oldTokenId: opData.oldTokenId || opData.activeTokenIdBefore,
        rebalanceWallet: opData.rebalanceWallet ?? true,
      };

      if (params.oldTokenId) {
        this.lpService.setTokenId(params.oldTokenId);
      }

      const referencePrice =
        opData.referencePrice && opData.referencePrice !== '0'
          ? new Decimal(opData.referencePrice)
          : (await this.getPriceResult()).price;

      // ==================== PREFLIGHT ====================
      if (!this.isStepCompleted(opState, ResetRangeStep.STEP_PREFLIGHT_OK)) {
        await this.stateStore.markStepStarted(
          opState.operationId,
          ResetRangeStep.STEP_PREFLIGHT_OK,
        );

        const lpComposition = await this.getLpComposition(referencePrice);
        const hedgeSnapshot = await this.hedgeService.getPosition();
        const priceResultForRisk = await this.getPriceResult();
        const riskFlags = await this.riskManager.evaluate({
          priceResult: priceResultForRisk,
          lpComposition,
          hedgeSnapshot,
        });

        if (!this.riskManager.canExecuteReset(riskFlags)) {
          const reason = `Reset blocked by risk: ${riskFlags.reasons.join(', ')}`;
          await this.stateStore.markStepFailed(
            opState.operationId,
            ResetRangeStep.STEP_PREFLIGHT_OK,
            reason,
          );
          stepsFailed.push(ResetRangeStep.STEP_PREFLIGHT_OK);
          await this.stateStore.failOp(opState.operationId, reason);
          return this.createFailedResult(
            startedAt,
            'reset_range',
            reason,
            opState.operationId,
            stepsCompleted,
            stepsFailed,
          );
        }

        await this.stateStore.markStep(opState.operationId, {
          stepName: ResetRangeStep.STEP_PREFLIGHT_OK,
          dataPatch: {
            passed: true,
            referencePrice: referencePrice.toString(),
          },
        });
        stepsCompleted.push(ResetRangeStep.STEP_PREFLIGHT_OK);
      }

      // Mark operation in progress AFTER preflight passes (or was already completed)
      this.riskManager.setOperationInProgress(true);

      // ==================== HEDGE SAFETY ====================
      if (!this.isStepCompleted(opState, ResetRangeStep.STEP_HEDGE_SAFETY_OK)) {
        await this.stateStore.markStepStarted(
          opState.operationId,
          ResetRangeStep.STEP_HEDGE_SAFETY_OK,
        );

        const hedgeSnapshot = await this.hedgeService.getPosition();
        const hedgeSafetyThreshold =
          params.hedgeSafetyThresholdPercent ||
          this.riskManager
            .getThresholds()
            .dangerLiquidationDistancePercent.toNumber();
        let hedgeSafetyResult: { reduced: boolean; newLiqDistance?: Decimal } =
          { reduced: false };

        if (
          hedgeSnapshot.hasPosition &&
          hedgeSnapshot.liquidationDistancePercent.lessThan(
            hedgeSafetyThreshold,
          )
        ) {
          const currentShort = hedgeSnapshot.shortNotionalUsdc;
          const reducedTarget = currentShort.mul(0.8);
          const reduceResult = await this.hedgeService.setTargetShortNotional(
            reducedTarget,
            HedgeUrgency.MARGIN_DANGER,
          );
          if (reduceResult.orderIds?.length)
            orderIds.push(...reduceResult.orderIds);

          const newHedgeSnapshot = await this.hedgeService.getPosition();
          hedgeSafetyResult = {
            reduced: true,
            newLiqDistance: newHedgeSnapshot.liquidationDistancePercent,
          };
        }

        await this.stateStore.markStep(opState.operationId, {
          stepName: ResetRangeStep.STEP_HEDGE_SAFETY_OK,
          dataPatch: {
            reduced: hedgeSafetyResult.reduced,
            newLiqDistance: hedgeSafetyResult.newLiqDistance?.toString(),
          },
        });
        stepsCompleted.push(ResetRangeStep.STEP_HEDGE_SAFETY_OK);
      }

      // ==================== DECREASE LIQUIDITY ====================
      if (
        !this.isStepCompleted(opState, ResetRangeStep.STEP_DECREASE_CONFIRMED)
      ) {
        const decreaseSent = this.getStepState(
          opState,
          ResetRangeStep.STEP_DECREASE_SENT,
        );
        const txHash = decreaseSent?.txHash || opData.tx?.decreaseTxHash;

        if (decreaseSent?.status === 'completed' && txHash) {
          await this.confirmTxStep(
            opState.operationId,
            ResetRangeStep.STEP_DECREASE_CONFIRMED,
            txHash,
            stepsCompleted,
          );
        } else {
          const position = await this.lpService.getPosition();
          if (position.liquidity.lte(0)) {
            await this.stateStore.markStep(opState.operationId, {
              stepName: ResetRangeStep.STEP_DECREASE_SENT,
              dataPatch: { skipped: true, reason: 'liquidity already zero' },
            });
            await this.stateStore.markStep(opState.operationId, {
              stepName: ResetRangeStep.STEP_DECREASE_CONFIRMED,
              dataPatch: { skipped: true, reason: 'liquidity already zero' },
            });
            stepsCompleted.push(
              ResetRangeStep.STEP_DECREASE_SENT,
              ResetRangeStep.STEP_DECREASE_CONFIRMED,
            );
          } else {
            await this.stateStore.markStepStarted(
              opState.operationId,
              ResetRangeStep.STEP_DECREASE_SENT,
            );
            const decreaseResult = await this.lpService.decreaseLiquidity({
              percent: 100,
            });
            if (decreaseResult.txHash) txHashes.push(decreaseResult.txHash);

            await this.stateStore.markStep(opState.operationId, {
              stepName: ResetRangeStep.STEP_DECREASE_SENT,
              txHash: decreaseResult.txHash,
            });
            stepsCompleted.push(ResetRangeStep.STEP_DECREASE_SENT);

            await this.confirmTxStep(
              opState.operationId,
              ResetRangeStep.STEP_DECREASE_CONFIRMED,
              decreaseResult.txHash,
              stepsCompleted,
            );

            if (decreaseResult.txHash) {
              await this.stateStore.updateResetRangeData(opState.operationId, {
                tx: { decreaseTxHash: decreaseResult.txHash },
              });
            }
          }

          // Clear activeTokenId after LP is closed (before new mint)
          // This prevents bot from using closed/empty LP on restart
          await this.stateStore.clearActiveTokenId(
            'LP decreased to 0% during resumed reset',
            opState.operationId,
          );
        }
      }

      // ==================== COLLECT FEES ====================
      if (
        !this.isStepCompleted(opState, ResetRangeStep.STEP_COLLECT_CONFIRMED)
      ) {
        const collectSent = this.getStepState(
          opState,
          ResetRangeStep.STEP_COLLECT_SENT,
        );
        const txHash = collectSent?.txHash || opData.tx?.collectTxHash;

        if (collectSent?.status === 'completed' && txHash) {
          await this.confirmTxStep(
            opState.operationId,
            ResetRangeStep.STEP_COLLECT_CONFIRMED,
            txHash,
            stepsCompleted,
          );
        } else {
          await this.stateStore.markStepStarted(
            opState.operationId,
            ResetRangeStep.STEP_COLLECT_SENT,
          );
          const collectResult = await this.lpService.collectFees();
          if (collectResult.txHash) txHashes.push(collectResult.txHash);

          await this.stateStore.markStep(opState.operationId, {
            stepName: ResetRangeStep.STEP_COLLECT_SENT,
            txHash: collectResult.txHash,
          });
          stepsCompleted.push(ResetRangeStep.STEP_COLLECT_SENT);

          await this.confirmTxStep(
            opState.operationId,
            ResetRangeStep.STEP_COLLECT_CONFIRMED,
            collectResult.txHash,
            stepsCompleted,
          );

          if (collectResult.txHash) {
            await this.stateStore.updateResetRangeData(opState.operationId, {
              tx: { collectTxHash: collectResult.txHash },
            });
          }
        }
      }

      // ==================== BALANCES SNAPSHOT ====================
      if (
        !this.isStepCompleted(opState, ResetRangeStep.STEP_BALANCES_SNAPSHOT)
      ) {
        await this.stateStore.markStepStarted(
          opState.operationId,
          ResetRangeStep.STEP_BALANCES_SNAPSHOT,
        );
        const balances =
          await this.walletService.getBalancesWithValue(referencePrice);
        const totalValueUsdc =
          balances.totalValueUsdc ||
          balances.weth.mul(referencePrice).add(balances.usdc);

        await this.stateStore.markStep(opState.operationId, {
          stepName: ResetRangeStep.STEP_BALANCES_SNAPSHOT,
          dataPatch: {
            weth: balances.weth.toString(),
            usdc: balances.usdc.toString(),
            totalUsdc: totalValueUsdc.toString(),
          },
        });
        stepsCompleted.push(ResetRangeStep.STEP_BALANCES_SNAPSHOT);
      }

      // ==================== SWAP ====================
      if (
        !this.isStepCompleted(opState, ResetRangeStep.STEP_SWAP_CONFIRMED) &&
        !this.isStepCompleted(opState, ResetRangeStep.STEP_SWAP_SKIPPED)
      ) {
        const swapSent = this.getStepState(
          opState,
          ResetRangeStep.STEP_SWAP_SENT,
        );
        const swapTxHash = swapSent?.txHash || opData.tx?.swapTxHash;

        if (swapSent?.status === 'completed' && swapTxHash) {
          await this.confirmTxStep(
            opState.operationId,
            ResetRangeStep.STEP_SWAP_CONFIRMED,
            swapTxHash,
            stepsCompleted,
          );
        } else {
          const balances =
            await this.walletService.getBalancesWithValue(referencePrice);
          const wethValue = balances.weth.mul(referencePrice);
          const totalValueComputed = balances.usdc.add(wethValue);
          const targetHalf = totalValueComputed.div(2);
          const imbalancePercent = wethValue
            .sub(targetHalf)
            .abs()
            .div(totalValueComputed)
            .mul(100);
          const swapPolicy = this.configService.swapPolicy || {
            deviationThresholdPct: 0.002,
            maxSlippageBps: 30,
            deadlineSec: 120,
            minNotionalUsdc: 200,
          };
          const imbalanceThresholdPct =
            this.configService.rebalance?.rebalanceImbalanceThresholdPct ?? 5;
          const needRebalance = imbalancePercent.gt(imbalanceThresholdPct);

          if (!params.rebalanceWallet || !needRebalance) {
            await this.stateStore.markStep(opState.operationId, {
              stepName: ResetRangeStep.STEP_SWAP_SKIPPED,
              dataPatch: {
                skipped: true,
                imbalancePercent: imbalancePercent.toFixed(2),
              },
            });
            stepsCompleted.push(ResetRangeStep.STEP_SWAP_SKIPPED);
          } else {
            await this.stateStore.markStepStarted(
              opState.operationId,
              ResetRangeStep.STEP_SWAP_SENT,
            );

            const currentPriceResult = await this.getPriceResult();
            const currentRiskFlags = await this.riskManager.evaluate({
              priceResult: currentPriceResult,
              lpComposition: await this.getLpComposition(referencePrice),
              hedgeSnapshot: await this.hedgeService.getPosition(),
            });

            if (!this.riskManager.canSwap(currentRiskFlags)) {
              const reason = `Swap blocked by RiskManager: ${currentRiskFlags.reasons.join(', ')}`;
              await this.stateStore.markStepFailed(
                opState.operationId,
                ResetRangeStep.STEP_SWAP_SENT,
                reason,
              );
              stepsFailed.push(ResetRangeStep.STEP_SWAP_SENT);
              await this.stateStore.failOp(opState.operationId, reason);
              this.riskManager.setOperationInProgress(false);
              return this.createFailedResult(
                startedAt,
                'reset_range',
                reason,
                opState.operationId,
                stepsCompleted,
                stepsFailed,
              );
            }

            // Calculate optimal WETH/USDC ratio for the new range
            const { wethPercent: targetWethPercent } =
              await this.lpService.calculateOptimalRatioForRange(
                newTickLower,
                newTickUpper,
              );

            this.logger.info('Resume: Calculated optimal ratio for new range', {
              newTickLower,
              newTickUpper,
              targetWethPercent: targetWethPercent.toFixed(1) + '%',
            });

            const rebalanceResult = await this.walletService.rebalanceTo50_50({
              referencePrice,
              deviationThresholdPct: swapPolicy.deviationThresholdPct,
              maxSlippageBps: swapPolicy.maxSlippageBps,
              deadlineSec: swapPolicy.deadlineSec,
              minNotionalUsdc: swapPolicy.minNotionalUsdc,
              dryRun: false,
              targetWethPercent: targetWethPercent.toNumber(),
            });

            if (!rebalanceResult.success) {
              const reason = `Rebalance swap failed: ${rebalanceResult.error || 'unknown error'}. Aborting reset.`;
              await this.stateStore.markStepFailed(
                opState.operationId,
                ResetRangeStep.STEP_SWAP_SENT,
                reason,
              );
              stepsFailed.push(ResetRangeStep.STEP_SWAP_SENT);
              await this.stateStore.failOp(opState.operationId, reason);
              this.riskManager.setOperationInProgress(false);
              return this.createFailedResult(
                startedAt,
                'reset_range',
                reason,
                opState.operationId,
                stepsCompleted,
                stepsFailed,
              );
            }

            if (rebalanceResult.txHash) txHashes.push(rebalanceResult.txHash);
            await this.stateStore.markStep(opState.operationId, {
              stepName: ResetRangeStep.STEP_SWAP_SENT,
              txHash: rebalanceResult.txHash,
            });
            stepsCompleted.push(ResetRangeStep.STEP_SWAP_SENT);

            await this.confirmTxStep(
              opState.operationId,
              ResetRangeStep.STEP_SWAP_CONFIRMED,
              rebalanceResult.txHash,
              stepsCompleted,
            );

            if (rebalanceResult.txHash) {
              await this.stateStore.updateResetRangeData(opState.operationId, {
                tx: { swapTxHash: rebalanceResult.txHash },
                swap: {
                  performed: rebalanceResult.performed,
                  direction:
                    rebalanceResult.direction === 'NONE'
                      ? undefined
                      : rebalanceResult.direction,
                  amountIn: rebalanceResult.amountIn?.toString(),
                  amountOutMin: rebalanceResult.amountOutMin?.toString(),
                  amountOut: rebalanceResult.amountOut?.toString(),
                },
              });
            }
          }
        }
      }

      // ==================== ALLOWANCES ====================
      if (!this.isStepCompleted(opState, ResetRangeStep.STEP_ALLOWANCES_OK)) {
        await this.stateStore.markStepStarted(
          opState.operationId,
          ResetRangeStep.STEP_ALLOWANCES_OK,
        );
        const balances = await this.walletService.getBalances();
        const positionManager = this.configService.web3.positionManagerAddress;
        const usdcAllowance = await this.walletService.ensureAllowance(
          this.configService.pool.token1Address,
          positionManager,
          balances.usdc,
        );
        if (!usdcAllowance.ok) {
          throw new Error(
            `USDC approval failed: ${usdcAllowance.error || 'unknown error'}`,
          );
        }
        if (usdcAllowance.txHash) {
          txHashes.push(usdcAllowance.txHash);
        }
        const wethAllowance = await this.walletService.ensureAllowance(
          this.configService.pool.token0Address,
          positionManager,
          balances.weth,
        );
        if (!wethAllowance.ok) {
          throw new Error(
            `WETH approval failed: ${wethAllowance.error || 'unknown error'}`,
          );
        }
        if (wethAllowance.txHash) {
          txHashes.push(wethAllowance.txHash);
        }

        if (!this.configService.isSimulationMode()) {
          if (usdcAllowance.txHash) {
            await this.txPolicyService.waitConfirmed(usdcAllowance.txHash);
          }
          if (wethAllowance.txHash) {
            await this.txPolicyService.waitConfirmed(wethAllowance.txHash);
          }
        }

        await this.stateStore.markStep(opState.operationId, {
          stepName: ResetRangeStep.STEP_ALLOWANCES_OK,
          txHash: wethAllowance.txHash || usdcAllowance.txHash,
          dataPatch: {
            usdcAllowanceTx: usdcAllowance.txHash,
            wethAllowanceTx: wethAllowance.txHash,
          },
        });
        stepsCompleted.push(ResetRangeStep.STEP_ALLOWANCES_OK);
      }

      // ==================== MINT ====================
      let newTokenId =
        opData.mint?.newTokenId ||
        this.getStepData(opState, ResetRangeStep.STEP_MINT_CONFIRMED)
          ?.newTokenId ||
        this.getStepData(opState, ResetRangeStep.STEP_MINT_SENT)?.newTokenId;
      const mintSent = this.getStepState(
        opState,
        ResetRangeStep.STEP_MINT_SENT,
      );
      let mintTxHash = mintSent?.txHash || opData.tx?.mintTxHash;

      if (!this.isStepCompleted(opState, ResetRangeStep.STEP_MINT_CONFIRMED)) {
        // Priority 1: If we have mintTxHash but no tokenId, try to extract from receipt
        // This is the most reliable recovery method - uses on-chain facts
        if (mintTxHash && !newTokenId) {
          this.logger.info(
            'Resume: mint tx exists but tokenId missing, extracting from receipt',
            { mintTxHash },
          );

          const extractedTokenId =
            await this.lpService.extractTokenIdFromMintTx(mintTxHash);

          if (extractedTokenId) {
            newTokenId = extractedTokenId;
            this.logger.info('Resume: recovered tokenId from mint tx receipt', {
              mintTxHash,
              tokenId: newTokenId,
            });

            // Update state with recovered tokenId
            await this.stateStore.markStep(opState.operationId, {
              stepName: ResetRangeStep.STEP_MINT_SENT,
              txHash: mintTxHash,
              dataPatch: { newTokenId, recoveredFromReceipt: true },
            });
            if (!this.isStepCompleted(opState, ResetRangeStep.STEP_MINT_SENT)) {
              stepsCompleted.push(ResetRangeStep.STEP_MINT_SENT);
            }

            await this.stateStore.updateResetRangeData(opState.operationId, {
              mint: { newTokenId },
            });
          } else {
            // Tx exists but no Transfer event - tx may have reverted or not mined yet
            this.logger.warn(
              'Resume: could not extract tokenId from mint tx (may have reverted)',
              { mintTxHash },
            );
            // Fall through to balance check / discovery
          }
        }

        // Priority 2: If MINT_SENT completed but still no tokenId, fail
        if (
          this.isStepCompleted(opState, ResetRangeStep.STEP_MINT_SENT) &&
          !newTokenId
        ) {
          const reason =
            'Resume failed: mint tx sent but tokenId could not be recovered from receipt';
          await this.stateStore.failOp(opState.operationId, reason);
          this.riskManager.setOperationInProgress(false);
          return this.createFailedResult(
            startedAt,
            'reset_range',
            reason,
            opState.operationId,
            stepsCompleted,
            stepsFailed,
          );
        }

        // Priority 3: No tokenId yet - check if we should mint or discover
        if (!newTokenId) {
          // Safety check: verify wallet has sufficient balance before minting
          // This prevents creating a tiny duplicate LP if previous mint succeeded but wasn't recorded
          const walletBalances = await this.walletService.getBalances();
          const wethValue = walletBalances.weth.mul(referencePrice);
          const totalAvailable = walletBalances.usdc.add(wethValue);
          const MIN_MINT_VALUE_USDC = new Decimal(50); // Minimum $50 to create LP

          if (totalAvailable.lt(MIN_MINT_VALUE_USDC)) {
            // Wallet is nearly empty - likely previous mint succeeded but wasn't recorded
            // Try to discover the position that was created
            this.logger.warn(
              'Resume: wallet balance too low for mint, checking for existing positions',
              {
                totalAvailable: totalAvailable.toFixed(2),
                minRequired: MIN_MINT_VALUE_USDC.toString(),
              },
            );

            const discovery = await this.lpService.discoverWalletPositions();
            if (discovery.bestActivePosition) {
              newTokenId = discovery.bestActivePosition.tokenId;
              this.logger.info(
                'Resume: discovered existing position from previous mint',
                {
                  tokenId: newTokenId,
                  liquidity: discovery.bestActivePosition.liquidity.toFixed(0),
                },
              );

              await this.stateStore.markStep(opState.operationId, {
                stepName: ResetRangeStep.STEP_MINT_SENT,
                dataPatch: { newTokenId, discoveredFromWallet: true },
              });
              stepsCompleted.push(ResetRangeStep.STEP_MINT_SENT);
            } else {
              const reason = `Resume failed: wallet balance too low ($${totalAvailable.toFixed(2)}) and no existing position found. Previous mint may have failed.`;
              await this.stateStore.failOp(opState.operationId, reason);
              this.riskManager.setOperationInProgress(false);
              return this.createFailedResult(
                startedAt,
                'reset_range',
                reason,
                opState.operationId,
                stepsCompleted,
                stepsFailed,
              );
            }
          } else {
            // Wallet has funds - proceed with mint
            await this.stateStore.markStepStarted(
              opState.operationId,
              ResetRangeStep.STEP_MINT_SENT,
            );
            const mintResult = await this.lpService.mintNewPositionForBudget({
              tickLower: params.newTickLower,
              tickUpper: params.newTickUpper,
              referencePrice,
              budgetPolicy: this.configService.mintPolicy
                ? {
                    useAllBalances:
                      this.configService.mintPolicy.useAllBalances,
                    reserveEthForGas: new Decimal(
                      this.configService.mintPolicy.reserveEthForGas,
                    ),
                    amountSafetyPct: new Decimal(
                      this.configService.mintPolicy.amountSafetyPct,
                    ),
                    amount0MinPct: new Decimal(
                      this.configService.mintPolicy.amount0MinPct,
                    ),
                    amount1MinPct: new Decimal(
                      this.configService.mintPolicy.amount1MinPct,
                    ),
                    deadlineSec: this.configService.mintPolicy.deadlineSec,
                    maxLeftoverPctWarn: new Decimal(
                      this.configService.mintPolicy.maxLeftoverPctWarn,
                    ),
                  }
                : undefined,
            });

            if (!mintResult.success) {
              const reason = `Mint failed: ${mintResult.error || mintResult.reason}`;
              await this.stateStore.markStepFailed(
                opState.operationId,
                ResetRangeStep.STEP_MINT_SENT,
                reason,
              );
              stepsFailed.push(ResetRangeStep.STEP_MINT_SENT);
              await this.stateStore.failOp(opState.operationId, reason);
              this.riskManager.setOperationInProgress(false);
              return this.createFailedResult(
                startedAt,
                'reset_range',
                reason,
                opState.operationId,
                stepsCompleted,
                stepsFailed,
              );
            }

            if (mintResult.txHash) txHashes.push(mintResult.txHash);
            newTokenId = mintResult.newTokenId;
            mintTxHash = mintResult.txHash || mintTxHash;

            await this.stateStore.markStep(opState.operationId, {
              stepName: ResetRangeStep.STEP_MINT_SENT,
              txHash: mintResult.txHash,
              dataPatch: { newTokenId },
            });
            stepsCompleted.push(ResetRangeStep.STEP_MINT_SENT);

            await this.stateStore.updateResetRangeData(opState.operationId, {
              tx: { mintTxHash: mintResult.txHash },
              mint: { newTokenId },
            });
          }
        }

        if (newTokenId) {
          this.lpService.setTokenId(newTokenId);
        }

        await this.confirmTxStep(
          opState.operationId,
          ResetRangeStep.STEP_MINT_CONFIRMED,
          mintTxHash,
          stepsCompleted,
          { newTokenId },
        );
      }

      if (newTokenId && this.lpService.getTokenId() !== newTokenId) {
        this.lpService.setTokenId(newTokenId);
      }

      // ==================== HEDGE AFTER RESET ====================
      if (
        !this.isStepCompleted(opState, ResetRangeStep.STEP_HEDGE_AFTER_RESET_OK)
      ) {
        const newComposition =
          await this.lpService.getComposition(referencePrice);
        const lpCompositionInput: LpCompositionInput = {
          wethAmount: newComposition.wethAmount,
          usdcAmount: newComposition.usdcAmount,
          totalValueUsdc: newComposition.totalValueUsdc,
          inRange: newComposition.inRange,
          currentTick: newComposition.currentTick,
          tickLower: params.newTickLower,
          tickUpper: params.newTickUpper,
          distanceToLowerPercent: newComposition.distanceToLowerPercent,
          distanceToUpperPercent: newComposition.distanceToUpperPercent,
        };

        const targetShortUsdc = this.strategyEngine.computeHedgeTarget(
          lpCompositionInput,
          referencePrice,
        );

        await this.stateStore.markStepStarted(
          opState.operationId,
          ResetRangeStep.STEP_HEDGE_AFTER_RESET_OK,
        );
        const rehedgeResult = await this.hedgeService.setTargetShortNotional(
          targetShortUsdc,
          HedgeUrgency.POST_RESET,
        );
        if (rehedgeResult.orderIds?.length)
          orderIds.push(...rehedgeResult.orderIds);

        const rehedgeDirection =
          rehedgeResult.operation === 'increase' ||
          rehedgeResult.operation === 'open'
            ? 'increase'
            : 'decrease';

        await this.stateStore.markStep(opState.operationId, {
          stepName: ResetRangeStep.STEP_HEDGE_AFTER_RESET_OK,
          dataPatch: {
            wethAmount: newComposition.wethAmount.toString(),
            usdcAmount: newComposition.usdcAmount.toString(),
            totalValueUsdc: newComposition.totalValueUsdc.toString(),
            targetShortUsdc: targetShortUsdc.toString(),
            executedAmount: rehedgeResult.deltaUsdc.toString(),
            avgPrice: rehedgeResult.avgExecutionPrice.toString(),
            direction: rehedgeDirection,
          },
        });
        stepsCompleted.push(ResetRangeStep.STEP_HEDGE_AFTER_RESET_OK);
      }

      // ==================== LEDGER ====================
      if (!this.isStepCompleted(opState, ResetRangeStep.STEP_LEDGER_RECORDED)) {
        await this.stateStore.markStepStarted(
          opState.operationId,
          ResetRangeStep.STEP_LEDGER_RECORDED,
        );
        const finalHedge = await this.hedgeService.getPosition();
        const newComposition =
          await this.lpService.getComposition(referencePrice);
        const walletBalances =
          await this.walletService.getBalancesWithValue(referencePrice);
        const walletEthValueUsdc = walletBalances.ethForGas.mul(referencePrice);
        await this.ledgerService.recordTick({
          prices: {
            cexPrice: referencePrice,
            dexPrice: referencePrice,
            referencePrice,
          },
          lp: {
            tokenId: newTokenId || 'unknown',
            inRange: newComposition.inRange,
            wethAmount: newComposition.wethAmount,
            usdcAmount: newComposition.usdcAmount,
            totalValueUsdc: newComposition.totalValueUsdc,
            tickLower: params.newTickLower,
            tickUpper: params.newTickUpper,
            currentTick: newComposition.currentTick,
          },
          wallet: {
            usdc: walletBalances.usdc,
            weth: walletBalances.weth,
            ethForGas: walletBalances.ethForGas,
            totalValueUsdc: walletBalances.totalValueUsdc || new Decimal(0),
            wethValueUsdc: walletBalances.wethValueUsdc || new Decimal(0),
            ethValueUsdc: walletEthValueUsdc,
          },
          hedge: {
            hasPosition: finalHedge.hasPosition,
            shortSizeEth: finalHedge.shortSizeEth,
            shortNotionalUsdc: finalHedge.shortNotionalUsdc,
            unrealizedPnl: finalHedge.unrealizedPnl,
            equity: finalHedge.equity,
            liquidationDistancePercent: finalHedge.liquidationDistancePercent,
          },
        });

        await this.stateStore.markStep(opState.operationId, {
          stepName: ResetRangeStep.STEP_LEDGER_RECORDED,
        });
        stepsCompleted.push(ResetRangeStep.STEP_LEDGER_RECORDED);

        // Store newComposition for completeReset
        opState.data.newCompositionWeth = newComposition.wethAmount.toString();
      }

      // ==================== DONE ====================
      if (!this.isStepCompleted(opState, ResetRangeStep.STEP_DONE)) {
        if (!newTokenId) {
          const reason = 'Resume failed: missing newTokenId before completion';
          await this.stateStore.failOp(opState.operationId, reason);
          this.riskManager.setOperationInProgress(false);
          return this.createFailedResult(
            startedAt,
            'reset_range',
            reason,
            opState.operationId,
            stepsCompleted,
            stepsFailed,
          );
        }

        await this.stateStore.markStepStarted(
          opState.operationId,
          ResetRangeStep.STEP_DONE,
        );
        this.lpService.setTokenId(newTokenId);
        await this.riskManager.recordReset();

        await this.stateStore.markStep(opState.operationId, {
          stepName: ResetRangeStep.STEP_DONE,
          dataPatch: {
            newTokenId,
            oldTokenId: params.oldTokenId,
          },
        });
        stepsCompleted.push(ResetRangeStep.STEP_DONE);
      }

      await this.stateStore.completeReset(
        opState.operationId,
        newTokenId,
        opState.data.newCompositionWeth || '0',
        {
          txHash: opData.tx?.mintTxHash,
          sourceOpId: opState.operationId,
        },
      );
      this.riskManager.setOperationInProgress(false);
      this.isCurrentlyExecuting = false;

      return {
        operationId: opState.operationId,
        status: 'resumed',
        operationType: 'reset_range',
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        stepsCompleted,
        stepsFailed,
        txHashes,
        orderIds,
        summary: 'Reset range resumed and completed',
        data: {
          newTokenId,
          newTickLower,
          newTickUpper,
        },
      };
    } finally {
      // Only reset isCurrentlyExecuting in finally
      // operationInProgress is managed explicitly in success/error paths
      this.isCurrentlyExecuting = false;
    }
  }

  // ==================== Emergency Exit Execution ====================

  /**
   * Execute emergency exit
   */
  async executeEmergencyExit(
    params: EmergencyExitParams,
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const txHashes: string[] = [];
    const orderIds: string[] = [];
    const stepsCompleted: string[] = [];
    const stepsFailed: string[] = [];

    this.isCurrentlyExecuting = true;
    this.abortRequested = false;

    let operationId: string | undefined;

    try {
      // Step 1: Begin operation
      const op = await this.stateStore.beginOp({
        type: 'emergency_exit',
        data: {
          reason: params.reason,
          triggerReasons: params.triggerReasons,
          swapToUsdc: params.swapToUsdc,
        },
        expectedSteps: Object.values(EMERGENCY_EXIT_STEPS),
      });
      operationId = op.operationId;

      this.logger.warn('Started EMERGENCY EXIT operation', {
        operationId,
        reason: params.reason,
      });

      this.riskManager.setOperationInProgress(true);

      // Step 2: Close hedge (reduce-only)
      await this.stateStore.markStepStarted(
        operationId,
        EMERGENCY_EXIT_STEPS.CLOSE_HEDGE,
      );

      try {
        const closeResult = await this.hedgeService.reduceOnlyCloseAll();
        if (closeResult.orderId) orderIds.push(closeResult.orderId);

        await this.stateStore.markStep(operationId, {
          stepName: EMERGENCY_EXIT_STEPS.CLOSE_HEDGE,
          dataPatch: {
            closedAmount: closeResult.closedUsdc.toString(),
            avgPrice: closeResult.executionPrice.toString(),
          },
        });
        stepsCompleted.push(EMERGENCY_EXIT_STEPS.CLOSE_HEDGE);

        // Record in ledger
        if (closeResult.closedUsdc.gt(0)) {
          await this.ledgerService.recordHedgeFill({
            orderId: closeResult.orderId || `emergency_close_${operationId}`,
            exchangeId: this.configService.hedgeExchange.id,
            symbol: this.configService.hedgeExchange.hedgeSymbol,
            side: 'buy', // Closing short = buying
            orderType: 'market',
            filledAmount: closeResult.closedEth,
            avgPrice: closeResult.executionPrice,
            feesUsdc: closeResult.feesUsdc,
          });
        }
      } catch (error) {
        this.logger.error('Failed to close hedge in emergency', error as Error);
        await this.stateStore.markStepFailed(
          operationId,
          EMERGENCY_EXIT_STEPS.CLOSE_HEDGE,
          (error as Error).message,
        );
        stepsFailed.push(EMERGENCY_EXIT_STEPS.CLOSE_HEDGE);
        // Continue anyway - we want to exit LP too
      }

      // Step 3: Decrease LP liquidity 100%
      await this.stateStore.markStepStarted(
        operationId,
        EMERGENCY_EXIT_STEPS.DECREASE_LIQUIDITY,
      );

      try {
        const decreaseResult = await this.lpService.decreaseLiquidity({
          percent: 100,
        });
        if (decreaseResult.txHash) txHashes.push(decreaseResult.txHash);

        await this.stateStore.markStep(operationId, {
          stepName: EMERGENCY_EXIT_STEPS.DECREASE_LIQUIDITY,
          txHash: decreaseResult.txHash,
        });
        stepsCompleted.push(EMERGENCY_EXIT_STEPS.DECREASE_LIQUIDITY);

        await this.ledgerService.recordDexTx({
          txHash: decreaseResult.txHash,
          type: 'decrease_liquidity',
          gasUsed: new Decimal(0),
        });
      } catch (error) {
        this.logger.error(
          'Failed to decrease liquidity in emergency',
          error as Error,
        );
        await this.stateStore.markStepFailed(
          operationId,
          EMERGENCY_EXIT_STEPS.DECREASE_LIQUIDITY,
          (error as Error).message,
        );
        stepsFailed.push(EMERGENCY_EXIT_STEPS.DECREASE_LIQUIDITY);
      }

      // Clear activeTokenId after LP is closed in emergency exit
      // Even if decrease failed, mark as inactive since we're exiting
      await this.stateStore.clearActiveTokenId(
        `Emergency exit: ${params.reason}`,
        operationId,
      );

      // Step 4: Collect fees
      await this.stateStore.markStepStarted(
        operationId,
        EMERGENCY_EXIT_STEPS.COLLECT_FEES,
      );

      try {
        const collectResult = await this.lpService.collectFees();
        if (collectResult.txHash) txHashes.push(collectResult.txHash);

        await this.stateStore.markStep(operationId, {
          stepName: EMERGENCY_EXIT_STEPS.COLLECT_FEES,
          txHash: collectResult.txHash,
          dataPatch: {
            amount0: collectResult.amount0.toString(),
            amount1: collectResult.amount1.toString(),
          },
        });
        stepsCompleted.push(EMERGENCY_EXIT_STEPS.COLLECT_FEES);

        await this.ledgerService.recordDexTx({
          txHash: collectResult.txHash,
          type: 'collect_fees',
          gasUsed: new Decimal(0),
        });
      } catch (error) {
        this.logger.error(
          'Failed to collect fees in emergency',
          error as Error,
        );
        await this.stateStore.markStepFailed(
          operationId,
          EMERGENCY_EXIT_STEPS.COLLECT_FEES,
          (error as Error).message,
        );
        stepsFailed.push(EMERGENCY_EXIT_STEPS.COLLECT_FEES);
      }

      // Step 5: Swap to USDC (optional)
      if (params.swapToUsdc) {
        await this.stateStore.markStepStarted(
          operationId,
          EMERGENCY_EXIT_STEPS.SWAP_TO_USDC,
        );

        try {
          const swapBalances = await this.walletService.getBalances();

          if (swapBalances.weth.gt(0)) {
            // Calculate minimum output with 1% slippage tolerance for emergency
            const currentPrice = (await this.hedgeService.getPosition())
              .markPrice;
            const expectedOut = swapBalances.weth.mul(currentPrice);
            const minAmountOut = expectedOut.mul(0.99); // 1% slippage

            const swapTxHash = await this.walletService.swap(
              this.configService.pool.token0Address, // WETH
              this.configService.pool.token1Address, // USDC
              swapBalances.weth,
              minAmountOut,
            );

            txHashes.push(swapTxHash);

            await this.stateStore.markStep(operationId, {
              stepName: EMERGENCY_EXIT_STEPS.SWAP_TO_USDC,
              txHash: swapTxHash,
              dataPatch: {
                amountIn: swapBalances.weth.toString(),
              },
            });

            await this.ledgerService.recordDexTx({
              txHash: swapTxHash,
              type: 'swap',
              gasUsed: new Decimal(0),
              priceUsdc: currentPrice,
            });
          } else {
            await this.stateStore.markStep(operationId, {
              stepName: EMERGENCY_EXIT_STEPS.SWAP_TO_USDC,
              dataPatch: { skipped: true, reason: 'No WETH to swap' },
            });
          }

          stepsCompleted.push(EMERGENCY_EXIT_STEPS.SWAP_TO_USDC);
        } catch (error) {
          this.logger.error(
            'Failed to swap to USDC in emergency',
            error as Error,
          );
          await this.stateStore.markStepFailed(
            operationId,
            EMERGENCY_EXIT_STEPS.SWAP_TO_USDC,
            (error as Error).message,
          );
          stepsFailed.push(EMERGENCY_EXIT_STEPS.SWAP_TO_USDC);
        }
      }

      // Step 6: Record in ledger
      await this.stateStore.markStepStarted(
        operationId,
        EMERGENCY_EXIT_STEPS.RECORD_LEDGER,
      );

      const referencePrice = new Decimal(0);
      const finalBalances =
        await this.walletService.getBalancesWithValue(referencePrice);
      await this.ledgerService.recordTick({
        prices: {
          cexPrice: new Decimal(0),
          dexPrice: new Decimal(0),
          referencePrice: new Decimal(0),
        },
        lp: {
          tokenId: undefined,
          inRange: false,
          wethAmount: new Decimal(0),
          usdcAmount: new Decimal(0),
          totalValueUsdc: new Decimal(0),
          tickLower: 0,
          tickUpper: 0,
          currentTick: 0,
        },
        wallet: {
          usdc: finalBalances.usdc,
          weth: finalBalances.weth,
          ethForGas: finalBalances.ethForGas,
          totalValueUsdc: finalBalances.totalValueUsdc || new Decimal(0),
          wethValueUsdc: finalBalances.wethValueUsdc || new Decimal(0),
          ethValueUsdc: new Decimal(0),
        },
        hedge: {
          hasPosition: false,
          shortSizeEth: new Decimal(0),
          shortNotionalUsdc: new Decimal(0),
          unrealizedPnl: new Decimal(0),
          equity: finalBalances.usdc,
          liquidationDistancePercent: new Decimal(100),
        },
      });

      await this.stateStore.markStep(operationId, {
        stepName: EMERGENCY_EXIT_STEPS.RECORD_LEDGER,
      });
      stepsCompleted.push(EMERGENCY_EXIT_STEPS.RECORD_LEDGER);

      // Step 7: Alert critical
      await this.stateStore.markStepStarted(
        operationId,
        EMERGENCY_EXIT_STEPS.ALERT_CRITICAL,
      );

      await this.monitoringService.alertCritical(
        `🚨 EMERGENCY EXIT COMPLETED\n\nReason: ${params.reason}\n\nFinal USDC: ${finalBalances.usdc.toFixed(2)}`,
        { component: ExecutionOrchestrator.name },
      );

      await this.stateStore.markStep(operationId, {
        stepName: EMERGENCY_EXIT_STEPS.ALERT_CRITICAL,
      });
      stepsCompleted.push(EMERGENCY_EXIT_STEPS.ALERT_CRITICAL);

      // Complete operation
      await this.stateStore.completeOp(operationId);
      this.riskManager.setOperationInProgress(false);

      const status: ExecutionStatus =
        stepsFailed.length > 0 ? 'partial' : 'success';

      return {
        operationId,
        status,
        operationType: 'emergency_exit',
        startedAt,
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        stepsCompleted,
        stepsFailed,
        txHashes,
        orderIds,
        summary: `Emergency exit ${status === 'success' ? 'completed' : 'completed with errors'}`,
        data: {
          reason: params.reason,
          finalUsdc: finalBalances.usdc.toString(),
        },
      };
    } catch (error) {
      const errorMsg = (error as Error).message;
      this.logger.error('Emergency exit failed critically', error as Error);

      if (operationId) {
        await this.stateStore.failOp(operationId, errorMsg);
      }

      this.riskManager.setOperationInProgress(false);

      return this.createFailedResult(
        startedAt,
        'emergency_exit',
        errorMsg,
        operationId,
        stepsCompleted,
        stepsFailed,
      );
    } finally {
      this.isCurrentlyExecuting = false;
    }
  }

  private async resumeEmergencyExit(
    opState: OpState,
    lastStep?: StepState,
  ): Promise<ExecutionResult> {
    const params: EmergencyExitParams = {
      reason: opState.data.reason || 'Resumed emergency exit',
      swapToUsdc: opState.data.swapToUsdc ?? true,
    };

    // For emergency, we restart from beginning
    // Could be smarter about checking what's already done
    this.logger.warn('Resuming emergency exit from beginning');

    await this.stateStore.failOp(opState.operationId, 'Resumed by restart');
    return this.executeEmergencyExit(params);
  }

  // ==================== Utility Methods ====================

  async hasOperationInProgress(): Promise<boolean> {
    return this.stateStore.hasInFlightOp();
  }

  async getInFlightOperation(): Promise<OpState | null> {
    return this.stateStore.getInFlightOp();
  }

  async abortOperation(): Promise<void> {
    this.abortRequested = true;
    this.logger.warn('Abort requested');
  }

  isExecuting(): boolean {
    return this.isCurrentlyExecuting;
  }

  // ==================== Private Helpers ====================

  private async getPriceResult() {
    const hedgeSnapshot = await this.hedgeService.getPosition();
    return {
      price: hedgeSnapshot.markPrice,
      source: 'cex' as const,
      timestamp: Date.now(),
      isHealthy: true,
    };
  }

  private async getLpComposition(referencePrice: Decimal) {
    const composition = await this.lpService.getComposition(referencePrice);
    const distances = await this.lpService.getDistanceToBounds();

    return {
      wethAmount: composition.wethAmount,
      usdcAmount: composition.usdcAmount,
      totalValueUsdc: composition.totalValueUsdc,
      inRange: composition.inRange,
      currentTick: composition.currentTick,
      tickLower: composition.tickLower,
      tickUpper: composition.tickUpper,
      distanceToLowerPercent: distances.toLower,
      distanceToUpperPercent: distances.toUpper,
    };
  }

  private getStepState(
    opState: OpState,
    stepName: string,
  ): StepState | undefined {
    return opState.steps.find((step) => step.stepName === stepName);
  }

  private isStepCompleted(opState: OpState, stepName: string): boolean {
    return this.getStepState(opState, stepName)?.status === 'completed';
  }

  private getStepData(
    opState: OpState,
    stepName: string,
  ): Record<string, any> | undefined {
    return this.getStepState(opState, stepName)?.data;
  }

  private async waitForConfirmation(txHash?: string): Promise<void> {
    if (!txHash) {
      return;
    }
    if (this.configService.isSimulationMode()) {
      return;
    }
    await this.txPolicyService.waitConfirmed(txHash);
  }

  /**
   * Confirm a transaction step with proper ordering:
   * 1. Mark step as started (for monitoring visibility)
   * 2. Wait for transaction confirmation
   * 3. Mark step as completed
   */
  private async confirmTxStep(
    opId: string,
    stepName: string,
    txHash: string | undefined,
    stepsCompleted: string[],
    dataPatch?: Record<string, any>,
  ): Promise<void> {
    // Mark step started BEFORE waiting (so monitoring shows "waiting for confirmation")
    await this.stateStore.markStepStarted(opId, stepName);

    // Wait for on-chain confirmation
    await this.waitForConfirmation(txHash);

    // Check for abort after waiting
    this.ensureNotAborted(opId);

    // Mark step completed
    await this.stateStore.markStep(opId, {
      stepName,
      txHash,
      dataPatch,
    });
    stepsCompleted.push(stepName);
  }

  private createSkippedResult(
    startedAt: number,
    reason: string,
  ): ExecutionResult {
    return {
      status: 'skipped',
      operationType: 'none',
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      stepsCompleted: [],
      stepsFailed: [],
      txHashes: [],
      orderIds: [],
      summary: reason,
    };
  }

  private createFailedResult(
    startedAt: number,
    opType: OpType | 'none',
    error: string,
    operationId?: string,
    stepsCompleted: string[] = [],
    stepsFailed: string[] = [],
  ): ExecutionResult {
    return {
      operationId,
      status: 'failed',
      operationType: opType,
      startedAt,
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      stepsCompleted,
      stepsFailed,
      txHashes: [],
      orderIds: [],
      error,
      summary: `Failed: ${error}`,
    };
  }
}
