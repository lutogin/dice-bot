import { injectable, inject } from 'tsyringe';
import { v4 as uuidv4 } from 'uuid';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import type { ILpPositionService } from '../lp-position';
import type { IMonitoringService } from '../monitoring';
import { OperationStateRepository } from '../../integrations/database/repositories/operation-state.repository';
import {
  OperationStatus,
  OperationType,
  IOperationState,
} from '../../integrations/database/schemas/operation-state.schema';
import { IStateStore } from './state-store.interface';
import {
  OpState,
  OpStatus,
  OpType,
  StepState,
  BeginOpInput,
  MarkStepInput,
  StateStoreConfig,
  DEFAULT_STATE_STORE_CONFIG,
  ResetRangeStep,
  ResetRangeOpData,
  GlobalState,
  DEFAULT_GLOBAL_STATE,
  RESET_RANGE_STEP_ORDER,
  ActiveTokenUpdate,
  LpBoundsCache,
} from './state-store.types';

/**
 * State Store Service
 * Prevents executing multi-step operations twice
 * and allows recovery after process crash
 */
@injectable()
export class StateStore implements IStateStore {
  private readonly logger: ILogger;
  private config: StateStoreConfig;
  private checkInterval: NodeJS.Timeout | null = null;
  private heartbeatIntervals: Map<string, NodeJS.Timeout> = new Map();
  private isRunning: boolean = false;

  // Global state (persisted)
  private globalState: GlobalState = { ...DEFAULT_GLOBAL_STATE };

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE)
    private readonly configService: ConfigService,
    @inject(TOKENS.STATE_STORE_REPOSITORY)
    private readonly repository: OperationStateRepository,
    @inject(TOKENS.MONITORING_SERVICE)
    private readonly monitoringService: IMonitoringService,
    @inject(TOKENS.LP_POSITION_SERVICE)
    private readonly lpService: ILpPositionService,
  ) {
    this.logger = logger.child('StateStore');
    this.config = { ...DEFAULT_STATE_STORE_CONFIG };

    this.logger.info('StateStore initialized');
  }

  // ==================== Core Methods ====================

  /**
   * Get current in-flight operation
   */
  async getInFlightOp(): Promise<OpState | null> {
    try {
      const doc = await this.repository.findInFlight();
      return doc ? this.toOpState(doc) : null;
    } catch (error) {
      this.logger.error('Failed to get in-flight operation', error as Error);
      return null;
    }
  }

  /**
   * Begin a new operation
   */
  async beginOp(input: BeginOpInput): Promise<OpState> {
    // Check for existing in-flight operation
    const existing = await this.getInFlightOp();
    if (existing) {
      throw new Error(
        `Cannot begin new operation: operation ${existing.operationId} (${existing.type}) is already in progress`,
      );
    }

    const operationId = uuidv4();
    const now = Date.now();

    // Create initial steps if provided
    const steps =
      input.expectedSteps?.map((stepName) => ({
        stepName,
        status: 'pending' as const,
      })) || [];

    try {
      const doc = await this.repository.create({
        operationId,
        type: this.toOperationType(input.type),
        data: input.data || {},
        steps,
      });

      const opState = this.toOpState(doc);

      this.logger.info('Operation started', {
        operationId,
        type: input.type,
        steps: input.expectedSteps,
      });

      // Start heartbeat for this operation
      this.startHeartbeat(operationId);

      return opState;
    } catch (error) {
      const err = error as { code?: number };
      if (err?.code === 11000) {
        const existing = await this.getInFlightOp();
        throw new Error(
          `Cannot begin new operation: operation ${existing?.operationId || 'unknown'} (${existing?.type || 'unknown'}) is already in progress`,
        );
      }
      this.logger.error('Failed to begin operation', error as Error);
      throw error;
    }
  }

  /**
   * Mark step as started
   */
  async markStepStarted(opId: string, stepName: string): Promise<void> {
    try {
      await this.repository.updateStep(opId, {
        stepName,
        status: 'started',
      });

      this.logger.debug('Step started', { opId, stepName });
    } catch (error) {
      this.logger.error('Failed to mark step started', error as Error, {
        opId,
        stepName,
      });
      throw error;
    }
  }

  /**
   * Mark step as completed with data
   */
  async markStep(opId: string, input: MarkStepInput): Promise<void> {
    try {
      await this.repository.updateStep(opId, {
        stepName: input.stepName,
        status: 'completed',
        data: input.dataPatch,
        txHash: input.txHash,
      });

      this.logger.info('Step completed', {
        opId,
        stepName: input.stepName,
        txHash: input.txHash,
      });
    } catch (error) {
      this.logger.error('Failed to mark step', error as Error, {
        opId,
        stepName: input.stepName,
      });
      throw error;
    }
  }

  /**
   * Mark step as failed
   */
  async markStepFailed(
    opId: string,
    stepName: string,
    error: string,
  ): Promise<void> {
    try {
      await this.repository.updateStep(opId, {
        stepName,
        status: 'failed',
        error,
      });

      this.logger.warn('Step failed', {
        opId,
        stepName,
        error,
      });
    } catch (err) {
      this.logger.error('Failed to mark step failed', err as Error, {
        opId,
        stepName,
      });
      throw err;
    }
  }

  /**
   * Complete the operation
   */
  async completeOp(opId: string): Promise<void> {
    try {
      await this.repository.updateStatus(opId, OperationStatus.COMPLETED);

      // Stop heartbeat
      this.stopHeartbeat(opId);

      this.logger.info('Operation completed', { opId });
    } catch (error) {
      this.logger.error('Failed to complete operation', error as Error, {
        opId,
      });
      throw error;
    }
  }

  /**
   * Fail the operation
   */
  async failOp(opId: string, error: string): Promise<void> {
    try {
      await this.repository.updateStatus(opId, OperationStatus.FAILED, error);

      // Stop heartbeat
      this.stopHeartbeat(opId);

      this.logger.error('Operation failed', new Error(error), { opId });

      // Send alert
      await this.monitoringService.alertCritical(
        `Operation ${opId} failed: ${error}`,
        {
          component: 'StateStore',
          error,
        },
      );
    } catch (err) {
      this.logger.error('Failed to fail operation', err as Error, { opId });
      throw err;
    }
  }

  /**
   * Update heartbeat
   */
  async heartbeat(opId: string): Promise<void> {
    try {
      await this.repository.updateHeartbeat(opId);
    } catch (error) {
      this.logger.error('Failed to update heartbeat', error as Error, { opId });
    }
  }

  /**
   * Check for stuck operations
   */
  async checkStuck(): Promise<string[]> {
    try {
      const candidates = await this.repository.findStuckCandidates(
        this.config.stuckTimeoutMs,
      );
      const stuckOps: IOperationState[] = [];

      for (const op of candidates) {
        const hasPendingTx = op.steps?.some(
          (step) => step.status === 'started' && Boolean(step.txHash),
        );

        if (hasPendingTx) {
          this.logger.info('Skipping stuck mark due to pending tx', {
            operationId: op.operationId,
            type: op.type,
          });
          continue;
        }

        stuckOps.push(op);
      }

      if (stuckOps.length > 0) {
        await this.repository.markStuckByIds(
          stuckOps.map((op) => op.operationId),
        );
      }

      // Alert for each stuck operation
      for (const op of stuckOps) {
        await this.monitoringService.alertCritical(
          `Operation ${op.operationId} (${op.type}) is stuck`,
          {
            component: 'StateStore',
          },
        );
      }

      return stuckOps.map((op) => op.operationId);
    } catch (error) {
      this.logger.error('Failed to check stuck operations', error as Error);
      return [];
    }
  }

  /**
   * Get operation by ID
   */
  async getOp(opId: string): Promise<OpState | null> {
    try {
      const doc = await this.repository.findById(opId);
      return doc ? this.toOpState(doc) : null;
    } catch (error) {
      this.logger.error('Failed to get operation', error as Error, { opId });
      return null;
    }
  }

  /**
   * Check if there is an operation in progress
   */
  async hasInFlightOp(): Promise<boolean> {
    const op = await this.getInFlightOp();
    return op !== null;
  }

  /**
   * Get current config
   */
  getConfig(): StateStoreConfig {
    return { ...this.config };
  }

  // ==================== Lifecycle ====================

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('StateStore already running');
      return;
    }

    this.isRunning = true;

    // Load global state from persistence
    await this.loadGlobalState();

    // Note: activeTokenId discovery/creation is now handled in App.ensureActiveLpPosition()
    // StateStore just loads from persistence and manages the state
    // LP bounds refresh is deferred until after ensureActiveLpPosition validates the tokenId

    // Check for stuck operations on startup
    const stuckOps = await this.checkStuck();
    if (stuckOps.length > 0) {
      this.logger.warn('Found stuck operations on startup', {
        count: stuckOps.length,
        operationIds: stuckOps,
      });
    }

    // Resume heartbeat for any in-flight operation
    const inFlight = await this.getInFlightOp();
    if (inFlight) {
      this.logger.info('Resuming in-flight operation', {
        operationId: inFlight.operationId,
        type: inFlight.type,
        status: inFlight.status,
        lastStep: await this.getLastCompletedStep(inFlight.operationId),
      });
      this.startHeartbeat(inFlight.operationId);
    }

    // Start periodic stuck check
    this.checkInterval = setInterval(
      () => this.checkStuck(),
      this.config.stuckTimeoutMs,
    );

    // Run cleanup if enabled
    if (this.config.autoCleanup) {
      await this.runCleanup();
    }

    this.logger.info('StateStore started', {
      activeTokenId: this.globalState.activeTokenId,
      resetsCount24h: this.globalState.resetsCount24h,
    });
  }

  async stop(): Promise<void> {
    // Stop all heartbeats
    for (const [opId, interval] of this.heartbeatIntervals) {
      clearInterval(interval);
    }
    this.heartbeatIntervals.clear();

    // Stop stuck checker
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    this.isRunning = false;
    this.logger.info('StateStore stopped');
  }

  // ==================== Active Token Management ====================

  /**
   * Get the currently active LP NFT token ID
   * Per runbook C: StrategyEngine should get tokenId from StateStore, not config
   */
  async getActiveTokenId(): Promise<string | null> {
    return this.globalState.activeTokenId;
  }

  /**
   * Set the active LP NFT token ID
   * Called after successful mint of new position (STEP_DONE)
   * Per spec: only update on STEP_DONE after ledger recorded
   */
  async setActiveTokenId(
    tokenId: string,
    meta?: ActiveTokenUpdate,
  ): Promise<void> {
    const oldTokenId = this.globalState.activeTokenId;
    this.updateActiveTokenState(tokenId, meta);

    this.logger.info('Active token ID updated', {
      oldTokenId,
      newTokenId: tokenId,
    });

    // Persist to DB
    await this.persistGlobalState();
  }

  /**
   * Clear the active LP NFT token ID
   *
   * Called when LP is closed (reset, emergency exit, etc.)
   * to prevent bot from trying to use a closed/empty LP on restart.
   */
  async clearActiveTokenId(reason: string, sourceOpId?: string): Promise<void> {
    const oldTokenId = this.globalState.activeTokenId;

    if (!oldTokenId) {
      this.logger.debug(
        'clearActiveTokenId called but no active token to clear',
      );
      return;
    }

    this.globalState.activeTokenId = null;
    this.globalState.activeTokenIdUpdatedAt = Date.now();
    this.globalState.activeTokenIdTxHash = null;
    this.globalState.activeTokenIdSourceOpId = sourceOpId ?? null;

    this.logger.info('Active token ID CLEARED', {
      clearedTokenId: oldTokenId,
      reason,
      sourceOpId,
    });

    // Persist to DB immediately
    await this.persistGlobalState();
  }

  /**
   * Complete reset and commit active token + reset timestamps
   * Also sets LP delta anchor for drift calculation
   *
   * @param opId - Operation ID
   * @param tokenId - New token ID
   * @param lpWethAmount - LP WETH amount after reset (for anchor)
   * @param meta - Optional metadata for token update
   */
  async completeReset(
    opId: string,
    tokenId: string,
    lpWethAmount: string,
    meta?: ActiveTokenUpdate,
  ): Promise<void> {
    const now = Date.now();
    this.updateActiveTokenState(tokenId, meta);
    this.updateResetCounters(now);

    // ==================== CRITICAL: Reset all drift/gap tracking state ====================
    // After LP reset, the position is completely new and all tracking must start fresh

    // 1. Set anchor to LP WETH amount after reset
    this.globalState.lpDeltaAnchor = lpWethAmount;
    this.globalState.lpDeltaAnchorSetAt = now;
    this.globalState.lpDeltaAnchorReason = 'lp_reset';

    // 2. Reset EMA to current LP WETH amount
    // This prevents stale EMA from causing false gap triggers
    // (e.g., old EMA of 3.1 ETH vs new position with 1.8 ETH)
    this.globalState.lpDeltaEma = lpWethAmount;
    this.globalState.lpDeltaEmaUpdatedAt = now;

    // 3. Reset wethAtLastHedge to match new LP position
    // This ensures drift calculation starts fresh after reset
    this.globalState.wethAtLastHedge = lpWethAmount;

    // 4. Reset hysteresis to STABLE
    // New position should start in stable state, not carry over ADJUSTED from old position
    this.globalState.hysteresisState = 'STABLE';

    // 5. Reset lastDecisionZone to null
    // New position is centered, so zone detection should start fresh
    this.globalState.lastDecisionZone = null;

    // 6. Update lastRehedgeAt to now
    // This prevents immediate rehedge after reset (cooldown applies)
    this.globalState.lastRehedgeAt = now;

    await this.persistGlobalState();
    await this.repository.updateStatus(opId, OperationStatus.COMPLETED);
    this.stopHeartbeat(opId);

    this.logger.info('Reset committed', {
      opId,
      tokenId,
      lpWethAmount,
      anchorSet: lpWethAmount,
      emaReset: lpWethAmount,
      wethAtLastHedgeReset: lpWethAmount,
      hysteresisReset: 'STABLE',
      lastDecisionZoneReset: null,
      lastRehedgeAt: now,
    });
  }

  /**
   * Get last reset timestamp
   */
  async getLastResetAt(): Promise<number | null> {
    return this.globalState.lastResetAt;
  }

  /**
   * Record reset timestamp (for rate limiting)
   */
  async recordReset(): Promise<void> {
    const now = Date.now();
    this.updateResetCounters(now);

    this.logger.info('Reset recorded', {
      lastResetAt: now,
      resetsIn24h: this.globalState.resetsCount24h,
    });

    // Persist to DB
    await this.persistGlobalState();
  }

  /**
   * Get reset count in last 24 hours
   */
  async getResetsCount24h(): Promise<number> {
    // Refresh count based on current timestamps
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    this.globalState.resetTimestamps = this.globalState.resetTimestamps.filter(
      (ts) => ts > cutoff,
    );
    this.globalState.resetsCount24h = this.globalState.resetTimestamps.length;
    return this.globalState.resetsCount24h;
  }

  // ==================== Resume & Idempotency Helpers ====================

  /**
   * Get the last completed step for an operation
   */
  async getLastCompletedStep(opId: string): Promise<ResetRangeStep | null> {
    const op = await this.getOp(opId);
    if (!op) return null;

    // Find last completed step in order
    let lastCompleted: ResetRangeStep | null = null;
    for (const step of RESET_RANGE_STEP_ORDER) {
      const stepState = op.steps.find((s) => s.stepName === step);
      if (stepState?.status === 'completed') {
        lastCompleted = step;
      }
    }
    return lastCompleted;
  }

  /**
   * Check if a step has been completed
   */
  async isStepCompleted(opId: string, step: ResetRangeStep): Promise<boolean> {
    const op = await this.getOp(opId);
    if (!op) return false;

    const stepState = op.steps.find((s) => s.stepName === step);
    return stepState?.status === 'completed';
  }

  /**
   * Check if a step is currently in "SENT" status (tx pending)
   */
  async isStepPending(opId: string, step: ResetRangeStep): Promise<boolean> {
    const op = await this.getOp(opId);
    if (!op) return false;

    const stepState = op.steps.find((s) => s.stepName === step);
    return stepState?.status === 'started';
  }

  /**
   * Get transaction hash for a step
   */
  async getStepTxHash(
    opId: string,
    step: ResetRangeStep,
  ): Promise<string | null> {
    const op = await this.getOp(opId);
    if (!op) return null;

    const stepState = op.steps.find((s) => s.stepName === step);
    return stepState?.txHash || null;
  }

  /**
   * Update transaction hash for a step (e.g., after bump and replace)
   */
  async updateStepTxHash(
    opId: string,
    step: ResetRangeStep,
    newTxHash: string,
  ): Promise<void> {
    try {
      await this.repository.updateStep(opId, {
        stepName: step,
        status: 'started', // Keep as started
        txHash: newTxHash,
      });

      this.logger.info('Step txHash updated', {
        opId,
        step,
        newTxHash,
      });
    } catch (error) {
      this.logger.error('Failed to update step txHash', error as Error, {
        opId,
        step,
      });
      throw error;
    }
  }

  /**
   * Get typed RESET_RANGE operation data
   */
  async getResetRangeData(opId: string): Promise<ResetRangeOpData | null> {
    const op = await this.getOp(opId);
    if (!op || op.type !== 'reset_range') return null;
    return op.data as ResetRangeOpData;
  }

  /**
   * Update RESET_RANGE operation data (merge)
   */
  async updateResetRangeData(
    opId: string,
    patch: Partial<ResetRangeOpData>,
  ): Promise<void> {
    try {
      const op = await this.getOp(opId);
      if (!op) throw new Error(`Operation ${opId} not found`);

      const currentData = op.data as ResetRangeOpData;
      const newData = this.deepMerge(currentData, patch);

      await this.repository.updateData(opId, newData);

      this.logger.debug('RESET_RANGE data updated', {
        opId,
        patchKeys: Object.keys(patch),
      });
    } catch (error) {
      this.logger.error('Failed to update RESET_RANGE data', error as Error, {
        opId,
      });
      throw error;
    }
  }

  /**
   * Increment attempt counter
   */
  async incrementAttempt(
    opId: string,
    attemptType: 'swap' | 'mint' | 'hedge',
  ): Promise<number> {
    const data = await this.getResetRangeData(opId);
    if (!data)
      throw new Error(`Operation ${opId} not found or not RESET_RANGE`);

    const attempts = data.attempts || {
      swapAttempts: 0,
      mintAttempts: 0,
      hedgeAttempts: 0,
    };
    const key = `${attemptType}Attempts` as keyof typeof attempts;
    attempts[key]++;

    await this.updateResetRangeData(opId, { attempts });

    this.logger.debug('Attempt incremented', {
      opId,
      attemptType,
      newCount: attempts[key],
    });

    return attempts[key];
  }

  /**
   * Add error to operation's error list
   */
  async addError(opId: string, error: string): Promise<void> {
    const data = await this.getResetRangeData(opId);
    if (!data) return;

    const errors = data.errors || [];
    errors.push(`[${new Date().toISOString()}] ${error}`);

    // Keep last 10 errors
    if (errors.length > 10) {
      errors.shift();
    }

    await this.updateResetRangeData(opId, { errors });
  }

  // ==================== LP Bounds Cache ====================

  /**
   * Get cached LP bounds for cheap in-range checks
   */
  getLpBoundsCache(): LpBoundsCache | null {
    return this.globalState.lpBoundsCache ?? null;
  }

  /**
   * Update LP bounds cache
   */
  async setLpBoundsCache(bounds: LpBoundsCache): Promise<void> {
    const oldCache = this.globalState.lpBoundsCache;

    this.globalState.lpBoundsCache = {
      ...bounds,
      isFresh: true,
    };

    this.logger.info('LP bounds cache updated', {
      tokenId: bounds.tokenId,
      tickLower: bounds.tickLower,
      tickUpper: bounds.tickUpper,
      feeTier: bounds.feeTier,
      wasEmpty: !oldCache,
    });

    await this.persistGlobalState();
  }

  /**
   * Clear LP bounds cache
   */
  async clearLpBoundsCache(): Promise<void> {
    if (!this.globalState.lpBoundsCache) {
      return;
    }

    const oldTokenId = this.globalState.lpBoundsCache.tokenId;
    this.globalState.lpBoundsCache = null;

    this.logger.info('LP bounds cache cleared', { oldTokenId });

    await this.persistGlobalState();
  }

  /**
   * Check if cached bounds are still fresh
   */
  isLpBoundsCacheFresh(maxAgeMs: number = 30 * 60 * 1000): boolean {
    const cache = this.globalState.lpBoundsCache;
    if (!cache) return false;

    const age = Date.now() - cache.lastConfirmedAt;
    return age < maxAgeMs;
  }

  /**
   * Quick check if current tick is in range using cached bounds
   * Does NOT make any RPC calls
   */
  checkInRangeFromCache(currentTick: number): {
    inRange: boolean;
    distanceToLowerPercent: number;
    distanceToUpperPercent: number;
  } | null {
    const cache = this.globalState.lpBoundsCache;
    if (!cache) return null;

    const { tickLower, tickUpper } = cache;
    const inRange = currentTick >= tickLower && currentTick < tickUpper;

    // Calculate distance as percentage of range
    const rangeWidth = tickUpper - tickLower;
    const distanceToLower = currentTick - tickLower;
    const distanceToUpper = tickUpper - currentTick;

    // Express as percentage of the total range
    const distanceToLowerPercent = (distanceToLower / rangeWidth) * 100;
    const distanceToUpperPercent = (distanceToUpper / rangeWidth) * 100;

    return {
      inRange,
      distanceToLowerPercent,
      distanceToUpperPercent,
    };
  }

  /**
   * Force refresh LP bounds from chain
   * Public wrapper for periodic reconciliation
   */
  async refreshLpBounds(): Promise<void> {
    await this.refreshLpBoundsCache();
  }

  // ==================== Global State Persistence ====================

  /**
   * Get full global state
   */
  async getGlobalState(): Promise<GlobalState> {
    return { ...this.globalState };
  }

  /**
   * Save global state to persistence
   */
  async persistGlobalState(): Promise<void> {
    try {
      // Store in a special document with fixed ID
      await this.repository.upsertGlobalState(this.globalState);
      this.logger.debug('Global state persisted');
    } catch (error) {
      this.logger.error('Failed to persist global state', error as Error);
      // Don't throw - this is best-effort persistence
    }
  }

  /**
   * Load global state from persistence
   */
  async loadGlobalState(): Promise<void> {
    try {
      const saved = await this.repository.getGlobalState();
      if (saved) {
        this.globalState = saved;

        // Refresh 24h counts
        const now = Date.now();
        const cutoff = now - 24 * 60 * 60 * 1000;
        this.globalState.resetTimestamps =
          this.globalState.resetTimestamps.filter((ts) => ts > cutoff);
        this.globalState.resetsCount24h =
          this.globalState.resetTimestamps.length;

        this.logger.info('Global state loaded', {
          activeTokenId: this.globalState.activeTokenId,
          resetsCount24h: this.globalState.resetsCount24h,
          lastRehedgeAt: this.globalState.lastRehedgeAt,
          wethAtLastHedge: this.globalState.wethAtLastHedge,
        });
      }
    } catch (error) {
      this.logger.error('Failed to load global state', error as Error);
      // Use defaults
      this.globalState = { ...DEFAULT_GLOBAL_STATE };
    }
  }

  // ==================== Rehedge Delta Drift Tracking ====================

  /**
   * Record rehedge execution (for cooldown, delta drift tracking, and hysteresis)
   * @param lpWethAmount - Current LP WETH amount at time of rehedge (as string)
   * @param rehedgeMode - Mode of rehedge ('gap_soft' triggers separate cooldown tracking)
   */
  async recordRehedge(
    lpWethAmount: string,
    rehedgeMode?: string,
  ): Promise<void> {
    const now = Date.now();
    const previousWeth = this.globalState.wethAtLastHedge;
    const previousHysteresis = this.globalState.hysteresisState;
    const previousAnchor = this.globalState.lpDeltaAnchor;

    // Update cooldown timestamp (always)
    this.globalState.lastRehedgeAt = now;

    // Update soft gap cooldown timestamp (only for gap_soft mode)
    if (rehedgeMode === 'gap_soft') {
      this.globalState.lastSoftGapRehedgeAt = now;
    }

    // Update WETH reference for legacy drift calculation
    this.globalState.wethAtLastHedge = lpWethAmount;

    // Update LP delta anchor to current EMA (or lpWethAmount if EMA not set)
    // This resets the drift calculation baseline after rehedge
    const currentEma = this.globalState.lpDeltaEma || lpWethAmount;
    this.globalState.lpDeltaAnchor = currentEma;
    this.globalState.lpDeltaAnchorSetAt = now;
    this.globalState.lpDeltaAnchorReason = 'rehedge_execution';

    // Set hysteresis to ADJUSTED after rehedge
    // This prevents immediate re-triggering until drift falls below exit threshold
    this.globalState.hysteresisState = 'ADJUSTED';

    await this.persistGlobalState();

    this.logger.info('Rehedge recorded with state updates', {
      lastRehedgeAt: now,
      lastSoftGapRehedgeAt:
        rehedgeMode === 'gap_soft'
          ? now
          : this.globalState.lastSoftGapRehedgeAt,
      rehedgeMode: rehedgeMode || 'normal',
      wethAtLastHedge: lpWethAmount,
      previousWeth: previousWeth || 'none',
      lpDeltaAnchor: currentEma,
      previousAnchor: previousAnchor || 'none',
      hysteresisState: 'ADJUSTED',
      previousHysteresis: previousHysteresis || 'STABLE',
    });
  }

  /**
   * Get timestamp of last rehedge
   */
  getLastRehedgeAt(): number | null {
    return this.globalState.lastRehedgeAt ?? null;
  }

  /**
   * Get timestamp of last soft gap rehedge (separate cooldown)
   */
  getLastSoftGapRehedgeAt(): number | null {
    return this.globalState.lastSoftGapRehedgeAt ?? null;
  }

  /**
   * Get LP WETH amount at last hedge (reference for delta drift)
   */
  getWethAtLastHedge(): string | null {
    return this.globalState.wethAtLastHedge ?? null;
  }

  /**
   * Initialize WETH reference (for bot startup when hedge already exists)
   * Only sets if not already set
   */
  async initializeWethReference(lpWethAmount: string): Promise<void> {
    if (this.globalState.wethAtLastHedge) {
      this.logger.debug('WETH reference already set, skipping initialization', {
        existing: this.globalState.wethAtLastHedge,
      });
      return;
    }

    this.globalState.wethAtLastHedge = lpWethAmount;
    await this.persistGlobalState();

    this.logger.info('Initialized WETH reference for delta drift tracking', {
      wethAtLastHedge: lpWethAmount,
    });
  }

  // ==================== Hysteresis State Management ====================

  /**
   * Get current hysteresis state
   */
  getHysteresisState(): 'STABLE' | 'ADJUSTED' {
    return this.globalState.hysteresisState ?? 'STABLE';
  }

  /**
   * Set hysteresis state to ADJUSTED (after rehedge)
   */
  async setHysteresisAdjusted(): Promise<void> {
    const previousState = this.globalState.hysteresisState;
    this.globalState.hysteresisState = 'ADJUSTED';
    await this.persistGlobalState();

    this.logger.info('Hysteresis state changed to ADJUSTED', {
      previousState,
    });
  }

  /**
   * Set hysteresis state to STABLE (when drift falls below exit threshold)
   */
  async setHysteresisStable(): Promise<void> {
    const previousState = this.globalState.hysteresisState;
    this.globalState.hysteresisState = 'STABLE';
    await this.persistGlobalState();

    this.logger.info('Hysteresis state changed to STABLE', {
      previousState,
    });
  }

  // ==================== LP Delta EMA Tracking ====================

  /**
   * Get current LP delta EMA
   */
  getLpDeltaEma(): string | null {
    return this.globalState.lpDeltaEma ?? null;
  }

  /**
   * Get timestamp of last EMA update
   */
  getLpDeltaEmaUpdatedAt(): number | null {
    return this.globalState.lpDeltaEmaUpdatedAt ?? null;
  }

  /**
   * Update LP delta EMA with new value
   */
  async updateLpDeltaEma(emaValue: string): Promise<void> {
    this.globalState.lpDeltaEma = emaValue;
    this.globalState.lpDeltaEmaUpdatedAt = Date.now();
    await this.persistGlobalState();

    this.logger.debug('LP delta EMA updated', {
      emaValue,
    });
  }

  /**
   * Get LP delta anchor (reference point for drift calculation)
   */
  getLpDeltaAnchor(): string | null {
    return this.globalState.lpDeltaAnchor ?? null;
  }

  /**
   * Set LP delta anchor
   */
  async setLpDeltaAnchor(anchorValue: string, reason: string): Promise<void> {
    const previousAnchor = this.globalState.lpDeltaAnchor;
    this.globalState.lpDeltaAnchor = anchorValue;
    this.globalState.lpDeltaAnchorSetAt = Date.now();
    this.globalState.lpDeltaAnchorReason = reason;
    await this.persistGlobalState();

    this.logger.info('LP delta anchor updated', {
      previousAnchor,
      newAnchor: anchorValue,
      reason,
    });
  }

  /**
   * Get timestamp when anchor was last set
   */
  getLpDeltaAnchorSetAt(): number | null {
    return this.globalState.lpDeltaAnchorSetAt ?? null;
  }

  /**
   * Get last decision zone (for boundary entry detection)
   */
  getLastDecisionZone(): 'lower' | 'middle' | 'upper' | null {
    return this.globalState.lastDecisionZone ?? null;
  }

  /**
   * Set last decision zone (called after each rehedge decision)
   */
  setLastDecisionZone(zone: 'lower' | 'middle' | 'upper'): void {
    this.globalState.lastDecisionZone = zone;
    // Note: not persisting immediately - will be saved with next persist call
  }

  // ==================== Private Methods ====================

  private startHeartbeat(opId: string): void {
    if (this.heartbeatIntervals.has(opId)) {
      return;
    }

    const interval = setInterval(
      () => this.heartbeat(opId),
      this.config.heartbeatIntervalMs,
    );

    this.heartbeatIntervals.set(opId, interval);
  }

  private stopHeartbeat(opId: string): void {
    const interval = this.heartbeatIntervals.get(opId);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(opId);
    }
  }

  private async runCleanup(): Promise<void> {
    try {
      const deleted = await this.repository.deleteOldCompleted(
        this.config.cleanupOlderThanDays,
      );

      if (deleted > 0) {
        this.logger.info('Cleanup completed', { deletedCount: deleted });
      }
    } catch (error) {
      this.logger.error('Cleanup failed', error as Error);
    }
  }

  private toOpState(doc: IOperationState): OpState {
    return {
      operationId: doc.operationId,
      type: this.toOpType(doc.type),
      status: this.toOpStatus(doc.status),
      data: doc.data,
      steps: doc.steps.map((s) => this.toStepState(s)),
      startedAt: doc.startedAt.getTime(),
      updatedAt: doc.updatedAt.getTime(),
      completedAt: doc.completedAt?.getTime(),
      error: doc.error,
      retryCount: doc.retryCount,
      lastHeartbeat: doc.lastHeartbeat.getTime(),
    };
  }

  private toStepState(step: any): StepState {
    return {
      stepName: step.stepName,
      status: step.status,
      startedAt: step.startedAt?.getTime(),
      completedAt: step.completedAt?.getTime(),
      data: step.data,
      txHash: step.txHash,
      error: step.error,
    };
  }

  private toOpType(type: OperationType): OpType {
    const map: Record<OperationType, OpType> = {
      [OperationType.RESET_RANGE]: 'reset_range',
      [OperationType.REHEDGE]: 'rehedge',
      [OperationType.COLLECT_FEES]: 'collect_fees',
      [OperationType.EMERGENCY_EXIT]: 'emergency_exit',
      [OperationType.REBALANCE_WALLET]: 'rebalance_wallet',
    };
    return map[type];
  }

  private toOperationType(type: OpType): OperationType {
    const map: Record<OpType, OperationType> = {
      reset_range: OperationType.RESET_RANGE,
      rehedge: OperationType.REHEDGE,
      collect_fees: OperationType.COLLECT_FEES,
      emergency_exit: OperationType.EMERGENCY_EXIT,
      rebalance_wallet: OperationType.REBALANCE_WALLET,
    };
    return map[type];
  }

  private toOpStatus(status: OperationStatus): OpStatus {
    const map: Record<OperationStatus, OpStatus> = {
      [OperationStatus.STARTED]: 'started',
      [OperationStatus.IN_PROGRESS]: 'in_progress',
      [OperationStatus.COMPLETED]: 'completed',
      [OperationStatus.FAILED]: 'failed',
      [OperationStatus.STUCK]: 'stuck',
      [OperationStatus.ROLLED_BACK]: 'rolled_back',
    };
    return map[status];
  }

  /**
   * Deep merge objects (for ResetRangeOpData updates)
   */
  private deepMerge<T extends Record<string, any>>(
    target: T,
    source: Partial<T>,
  ): T {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      const srcVal = source[key as keyof T];
      const tgtVal = target[key as keyof T];

      if (
        srcVal &&
        typeof srcVal === 'object' &&
        !Array.isArray(srcVal) &&
        tgtVal &&
        typeof tgtVal === 'object' &&
        !Array.isArray(tgtVal)
      ) {
        (result as any)[key] = this.deepMerge(
          tgtVal as Record<string, any>,
          srcVal as Record<string, any>,
        );
      } else if (srcVal !== undefined) {
        (result as any)[key] = srcVal;
      }
    }
    return result;
  }

  private updateActiveTokenState(
    tokenId: string,
    meta?: ActiveTokenUpdate,
  ): void {
    this.globalState.activeTokenId = tokenId;
    this.globalState.activeTokenIdUpdatedAt = meta?.updatedAt ?? Date.now();
    this.globalState.activeTokenIdTxHash = meta?.txHash ?? null;
    this.globalState.activeTokenIdSourceOpId = meta?.sourceOpId ?? null;
  }

  private updateResetCounters(now: number): void {
    this.globalState.lastResetAt = now;
    this.globalState.resetTimestamps.push(now);

    // Cleanup old timestamps (older than 24h)
    const cutoff = now - 24 * 60 * 60 * 1000;
    this.globalState.resetTimestamps = this.globalState.resetTimestamps.filter(
      (ts) => ts > cutoff,
    );
    this.globalState.resetsCount24h = this.globalState.resetTimestamps.length;
  }

  /**
   * Refresh LP bounds cache from on-chain data
   * Called on startup and periodically for reconciliation
   */
  private async refreshLpBoundsCache(): Promise<void> {
    const tokenId = this.globalState.activeTokenId;
    if (!tokenId) {
      this.logger.debug('No activeTokenId, skipping LP bounds refresh');
      return;
    }

    try {
      const position = await this.lpService.getPositionById(tokenId);

      const bounds: LpBoundsCache = {
        tokenId,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        feeTier: position.fee,
        poolAddress: this.configService.pool.poolAddress,
        lastConfirmedAt: Date.now(),
        isFresh: true,
      };

      await this.setLpBoundsCache(bounds);

      this.logger.info('LP bounds cache refreshed from chain', {
        tokenId,
        tickLower: bounds.tickLower,
        tickUpper: bounds.tickUpper,
      });
    } catch (error) {
      this.logger.warn('Failed to refresh LP bounds cache', {
        tokenId,
        error: (error as Error).message,
      });

      // Clear cache if position doesn't exist
      await this.clearLpBoundsCache();

      await this.monitoringService.alertWarn('LP position not found on-chain', {
        component: 'StateStore',
        tokenId,
        error: error as Error,
      });
    }
  }
}
