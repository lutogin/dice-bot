import { inject, injectable } from 'tsyringe';

import { ConfigService } from './config';
import Decimal from 'decimal.js';
import { SchedulerService } from './infra/scheduler/scheduler';
import { setupEventHandlers } from './infra/event-bus/event-bus.decorators';
import { Logger, ILogger } from './infra/logger/logger';
import { TOKENS } from './di/tokens';
import { MongoClient } from './integrations/database/mongo-client';
import { CommunicatorService } from './domain/communicator';
import type { ILpPositionService } from './domain/lp-position';
import type { IHedgeService } from './domain/hedge';
import { HedgeUrgency } from './domain/hedge/hedge.types';
import type { IStrategyEngine } from './domain/strategy';
import type { IExecutionOrchestrator } from './domain/execution';
import type { IRiskManager } from './domain/risk';
import type { IPriceService } from './domain/price';
import type { IMonitoringService } from './domain/monitoring';
import type { ITxPolicyService } from './domain/tx-policy';
import type { IWalletService } from './domain/wallet';
import type { ILedgerService } from './domain/ledger';
import type { IStateStore } from './domain/state-store';
import type { IRangeModelService } from './domain/range-model';
import type { IDynamicThresholdService } from './domain/dynamic-threshold';

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc'; // init and add plugin
import timezone from 'dayjs/plugin/timezone'; // init and add plugin
import duration from 'dayjs/plugin/duration'; // init and add plugin
import relativeTime from 'dayjs/plugin/relativeTime'; // init and add plugin
dayjs.extend(utc); // add plugin to dayjs
dayjs.extend(timezone); // do not remove. global dayjs with timezone support
dayjs.extend(duration); // add plugin to dayjs
dayjs.extend(relativeTime); // add plugin to dayjs

@injectable()
export class App {
  private isRunning = false;
  private shutdownHandlers: Array<() => Promise<void>> = [];
  private mainLoopTimer: NodeJS.Timeout | null = null;
  private mainLoopInProgress = false;
  private lastMainLoopAt: number | null = null;

  // Flag: CEX telemetry triggered DEX confirmation
  private needDexConfirmation = false;
  private dexConfirmRetries = 0;
  private readonly maxDexConfirmRetries = 5;
  private lastCexTelemetryAt: number | null = null;
  private lastDexConfirmAt: number | null = null;

  // Single-flight flags to prevent loop overlap
  private cexLoopRunning = false;
  private dexLoopRunning = false;
  private reconcileLoopRunning = false;

  private readonly logger: ILogger;

  constructor(
    @inject(TOKENS.SCHEDULER_SERVICE)
    private readonly schedulerService: SchedulerService,
    @inject(TOKENS.CONFIG_SERVICE)
    private readonly configService: ConfigService,
    @inject(TOKENS.MONGO_CLIENT) private readonly mongoClient: MongoClient,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.COMMUNICATOR_SERVICE)
    private readonly communicatorService: CommunicatorService,
    @inject(TOKENS.LP_POSITION_SERVICE)
    private readonly lpPositionService: ILpPositionService,
    @inject(TOKENS.HEDGE_SERVICE) private readonly hedgeService: IHedgeService,
    @inject(TOKENS.STRATEGY_ENGINE)
    private readonly strategyEngine: IStrategyEngine,
    @inject(TOKENS.EXECUTION_ORCHESTRATOR)
    private readonly executionOrchestrator: IExecutionOrchestrator,
    @inject(TOKENS.RISK_MANAGER) private readonly riskManager: IRiskManager,
    @inject(TOKENS.PRICE_SERVICE) private readonly priceService: IPriceService,
    @inject(TOKENS.MONITORING_SERVICE)
    private readonly monitoringService: IMonitoringService,
    @inject(TOKENS.TX_POLICY_SERVICE)
    private readonly txPolicyService: ITxPolicyService,
    @inject(TOKENS.WALLET_SERVICE)
    private readonly walletService: IWalletService,
    @inject(TOKENS.LEDGER_SERVICE)
    private readonly ledgerService: ILedgerService,
    @inject(TOKENS.STATE_STORE) private readonly stateStore: IStateStore,
    @inject(TOKENS.RANGE_MODEL_SERVICE)
    private readonly rangeModelService: IRangeModelService,
    @inject(TOKENS.DYNAMIC_THRESHOLD_SERVICE)
    private readonly dynamicThresholdService: IDynamicThresholdService,
  ) {
    this.logger = logger.child('App');
    this.setupShutdownHandlers();
    setupEventHandlers(this);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Application is already running');
      return;
    }

    try {
      // Запускаем планировщик
      await this.schedulerService.start();
      this.addShutdownHandler('SchedulerService', () =>
        this.schedulerService.stop(),
      );

      // Запускаем MongoDB
      await this.mongoClient.start();
      this.addShutdownHandler('MongoClient', () => this.mongoClient.stop());

      // Подключаемся к CEX (Binance) до запуска cron задач
      await this.hedgeService.connect();
      this.addShutdownHandler('HedgeService', () =>
        this.hedgeService.disconnect(),
      );

      // Запускаем StateStore (global state, heartbeats)
      await this.stateStore.start();
      this.addShutdownHandler('StateStore', () => this.stateStore.stop());

      // Ensure we have an active LP position (discover or create)
      await this.ensureActiveLpPosition();

      // Now that we have a valid tokenId, refresh LP bounds cache
      await this.stateStore.refreshLpBounds();

      // Initialize WETH reference for delta drift tracking (if hedge exists)
      await this.initializeWethReference();

      this.startCexTelemetryLoop();
      this.startDexConfirmLoop();
      this.startMainLoop();
      this.startMonitoringJobs();
      this.startLpBoundsReconcile();
      this.startDynamicThresholdRecalculation();

      this.isRunning = true;
      this.startMessage();
    } catch (error) {
      this.logger.error('Failed to start application', error as Error);
      await this.stop();
      throw error;
    }

    this.logger.info('🚀 Application initialized');
  }

  startMessage(): void {
    this.logger.info('Hedged LP Bot started successfully', {
      mode: this.configService.isSimulationMode() ? '🔵 SIMULATION' : '🟢 REAL',
      pool: this.configService.getPoolPairSymbol(),
      hedgeExchange: this.configService.hedgeExchange.id,
      chainId: this.configService.web3.chainId,
      environment: this.configService.nodeEnv,
    });
  }

  /**
   * Ensure we have an active LP position at startup
   * 1. Check global state for existing activeTokenId
   * 2. If exists, validate it's still valid on-chain
   * 3. If not exists, try to discover an active position for the configured pool
   * 4. If still not found and LP_AUTO_CREATE_ENABLED=true and not in simulation mode, create new LP
   * 5. Save activeTokenId to global state
   */
  private async ensureActiveLpPosition(): Promise<void> {
    this.logger.info('Ensuring active LP position...');

    // Step 1: Try to use existing position from state
    const existingTokenId = await this.stateStore.getActiveTokenId();
    if (existingTokenId) {
      const validationResult =
        await this.validateExistingLpPosition(existingTokenId);
      if (validationResult.isValid) {
        return;
      }
    }

    // Step 2: Try to discover an active position from wallet
    const discoveryResult = await this.discoverAndSelectLpPosition();
    if (discoveryResult.found) {
      return;
    }

    // Step 3: Check preconditions for creating new LP
    const preconditions = await this.checkLpCreationPreconditions();
    if (!preconditions.canCreate) {
      return;
    }

    // Step 4: Create new LP position with hedge
    await this.createNewLpPositionWithHedge();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LP Position Lifecycle Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Validate existing LP position from state
   * Returns isValid=true if position can be used, false if should try discovery
   */
  private async validateExistingLpPosition(
    tokenId: string,
  ): Promise<{ isValid: boolean }> {
    const minLpValueUsdc =
      this.configService.lpRange?.minPositionValueUsdc ?? 50;

    // Check if position exists on-chain
    const isValidOnChain =
      await this.lpPositionService.isValidPosition(tokenId);
    if (!isValidOnChain) {
      this.logger.warn('Existing tokenId is no longer valid, clearing', {
        tokenId,
      });
      await this.stateStore.clearActiveTokenId(
        'Position no longer valid on-chain',
      );
      return { isValid: false };
    }

    // Check liquidity and value
    try {
      const position = await this.lpPositionService.getPositionById(tokenId);

      if (position.liquidity.lte(0)) {
        this.logger.warn(
          'Existing tokenId has zero liquidity, clearing and will try to find another',
          { tokenId },
        );
        await this.stateStore.clearActiveTokenId('Position has zero liquidity');
        this.lpPositionService.setTokenId('');
        return { isValid: false };
      }

      // Check position value to avoid dust positions
      this.lpPositionService.setTokenId(tokenId);
      const referencePrice = await this.priceService.getReferencePrice();
      const composition = await this.lpPositionService.getComposition(
        new Decimal(referencePrice.dexPrice ?? referencePrice.price),
      );

      if (composition.totalValueUsdc.lt(minLpValueUsdc)) {
        this.logger.warn(
          'Existing tokenId is too small (dust), will create new LP',
          {
            tokenId,
            totalValueUsdc: composition.totalValueUsdc.toFixed(2),
            minRequired: minLpValueUsdc,
          },
        );
        await this.stateStore.clearActiveTokenId(
          'Position value below minimum threshold',
        );
        this.lpPositionService.setTokenId('');
        return { isValid: false };
      }

      this.logger.info('Using existing active LP position from state', {
        tokenId,
        totalValueUsdc: composition.totalValueUsdc.toFixed(2),
        liquidity: position.liquidity.toFixed(0),
      });
      return { isValid: true };
    } catch (error) {
      this.logger.warn('Failed to validate existing tokenId', {
        tokenId,
        error: (error as Error).message,
      });
      return { isValid: false };
    }
  }

  /**
   * Discover LP positions from wallet and select the best one
   * Returns found=true if valid position was discovered and set
   */
  private async discoverAndSelectLpPosition(): Promise<{ found: boolean }> {
    this.logger.info('Discovering LP positions from wallet...');
    const discoveryResult =
      await this.lpPositionService.discoverWalletPositions();

    if (!discoveryResult.bestActivePosition) {
      this.logger.info('No active LP position found', {
        totalNfts: discoveryResult.totalNfts,
        matchingPool: discoveryResult.matchingPoolPositions.length,
        activePositions: discoveryResult.activePositions.length,
      });
      return { found: false };
    }

    const tokenId = discoveryResult.bestActivePosition.tokenId;
    const minLpValueUsdc =
      this.configService.lpRange?.minPositionValueUsdc ?? 50;

    // Check position value
    this.lpPositionService.setTokenId(tokenId);
    const referencePrice = await this.priceService.getReferencePrice();
    const composition = await this.lpPositionService.getComposition(
      new Decimal(referencePrice.dexPrice ?? referencePrice.price),
    );

    if (composition.totalValueUsdc.lt(minLpValueUsdc)) {
      this.logger.warn(
        'Discovered position is too small (dust), will create new LP',
        {
          tokenId,
          totalValueUsdc: composition.totalValueUsdc.toFixed(2),
          minRequired: minLpValueUsdc,
          liquidity: discoveryResult.bestActivePosition.liquidity.toFixed(0),
        },
      );
      this.lpPositionService.setTokenId('');
      return { found: false };
    }

    this.logger.info('Discovered active LP position', {
      tokenId,
      totalValueUsdc: composition.totalValueUsdc.toFixed(2),
      liquidity: discoveryResult.bestActivePosition.liquidity.toFixed(0),
      totalNfts: discoveryResult.totalNfts,
      matchingPool: discoveryResult.matchingPoolPositions.length,
    });

    await this.stateStore.setActiveTokenId(tokenId);
    return { found: true };
  }

  /**
   * Initialize WETH reference for delta drift tracking
   * Called on startup when LP and hedge positions already exist
   */
  private async initializeWethReference(): Promise<void> {
    try {
      // Check if we have a hedge position
      const hedgeSnapshot = await this.hedgeService.getPosition();
      if (hedgeSnapshot.shortNotionalUsdc.lte(100)) {
        this.logger.info(
          'No significant hedge position, skipping WETH reference initialization',
        );
        return;
      }

      // Get current LP composition using DEX price for consistency with drift calculation
      const referencePrice = await this.priceService.getReferencePrice();
      const dexPrice = new Decimal(
        referencePrice.dexPrice ?? referencePrice.price,
      );
      const composition = await this.lpPositionService.getComposition(dexPrice);

      if (composition.wethAmount.lte(0)) {
        this.logger.info(
          'No WETH in LP, skipping WETH reference initialization',
        );
        return;
      }

      // Initialize reference point
      this.riskManager.initializeWethReference(composition.wethAmount);
    } catch (error) {
      this.logger.warn('Failed to initialize WETH reference', {
        error: (error as Error).message,
      });
    }
  }

  /**
   * Check if LP creation is allowed (config flags, simulation mode, etc.)
   */
  private async checkLpCreationPreconditions(): Promise<{
    canCreate: boolean;
  }> {
    const autoCreateEnabled =
      this.configService.lpRange?.autoCreateEnabled ?? false;
    const simulationMode = this.configService.isSimulationMode();

    if (!autoCreateEnabled) {
      this.logger.warn(
        'LP_AUTO_CREATE_ENABLED=false, bot will run without LP position',
      );
      await this.monitoringService.alertWarn('No active LP position found', {
        component: 'App',
        action:
          'Set LP_AUTO_CREATE_ENABLED=true to auto-create or manually create LP position',
      });
      return { canCreate: false };
    }

    if (simulationMode) {
      this.logger.warn('Simulation mode enabled, skipping LP creation');
      await this.monitoringService.alertInfo(
        'Simulation mode - LP creation skipped',
        {
          component: 'App',
          reason: 'SIMULATION_MODE=true',
        },
      );
      return { canCreate: false };
    }

    return { canCreate: true };
  }

  /**
   * Create new LP position and adjust hedge accordingly
   * IMPORTANT: This method performs real trades - must not be called in simulation mode
   */
  private async createNewLpPositionWithHedge(): Promise<void> {
    // Safety guard: never create LP in simulation mode
    if (this.configService.isSimulationMode()) {
      this.logger.warn(
        'createNewLpPositionWithHedge called in simulation mode - skipping',
      );
      return;
    }

    this.logger.info('Auto-creating new LP position...');

    try {
      // Calculate range parameters
      const rangeParams = await this.calculateLpRangeParams();
      if (!rangeParams) {
        return; // Error already logged
      }

      // Prepare wallet (wrap ETH, rebalance)
      const walletReady = await this.prepareWalletForLpCreation(rangeParams);
      if (!walletReady) {
        return; // Error already logged
      }

      // Mint position
      const mintResult = await this.mintNewLpPosition(rangeParams);
      if (!mintResult.success || !mintResult.tokenId) {
        return; // Error already logged
      }

      // Adjust hedge for new LP
      await this.adjustHedgeForNewLp(
        mintResult.tokenId,
        rangeParams.tickLower,
        rangeParams.tickUpper,
      );
    } catch (error) {
      this.logger.error('Error during LP creation', error as Error);
      await this.monitoringService.alertCritical('LP creation error', {
        component: 'App',
        error: (error as Error).message,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LP Creation Sub-steps
  // ─────────────────────────────────────────────────────────────────────────

  private async calculateLpRangeParams(): Promise<{
    tickLower: number;
    tickUpper: number;
    rangeWidthPercent: number;
    rangeSource: 'DYNAMIC' | 'FALLBACK';
    poolState: { tick: number; spotPrice: Decimal };
  } | null> {
    const poolState = await this.lpPositionService.getPoolState();

    // Try dynamic range from RangeModelService
    let rangeWidthPercent: number;
    let rangeSource: 'DYNAMIC' | 'FALLBACK' = 'DYNAMIC';

    try {
      const dynamicRange = await this.rangeModelService.calculateDynamicRange();
      rangeWidthPercent = dynamicRange.rangeWidthPercent.toNumber();

      this.logger.info('Using dynamic range from RangeModelService', {
        rangeWidthPercent,
        regime: dynamicRange.regime,
        volatility1d: dynamicRange.volatility1d.toFixed(4),
        volatility3d: dynamicRange.volatility3d.toFixed(4),
        effectiveVol: dynamicRange.volatility24h.toFixed(4),
      });

      // Check for CHAOS regime
      if (!dynamicRange.lpEnabled) {
        this.logger.warn(
          'RangeModelService recommends disabling LP due to high volatility',
          {
            regime: dynamicRange.regime,
          },
        );
        await this.monitoringService.alertWarn(
          'High volatility detected - LP creation skipped',
          {
            component: 'App',
            regime: dynamicRange.regime,
            volatility: dynamicRange.volatility24h.toFixed(4),
          },
        );
        return null;
      }
    } catch (error) {
      // Config uses fraction (0.10 = 10%), method expects percent (10 = 10%)
      rangeWidthPercent =
        (this.configService.lpRange?.rangeWidthPercent ?? 0.1) * 100;
      rangeSource = 'FALLBACK';

      this.logger.warn('RangeModelService failed, using config fallback', {
        rangeWidthPercent,
        error: (error as Error).message,
      });
    }

    const { tickLower, tickUpper } =
      await this.lpPositionService.calculateSymmetricRange(rangeWidthPercent);

    this.logger.info('Creating LP position with symmetric range', {
      rangeWidthPercent,
      rangeSource,
      currentTick: poolState.tick,
      tickLower,
      tickUpper,
      spotPrice: poolState.spotPrice.toFixed(2),
    });

    return { tickLower, tickUpper, rangeWidthPercent, rangeSource, poolState };
  }

  private async prepareWalletForLpCreation(rangeParams: {
    tickLower: number;
    tickUpper: number;
    poolState: { tick: number; spotPrice: Decimal };
  }): Promise<boolean> {
    let balances = await this.walletService.getBalances();

    // Auto-wrap native ETH to WETH
    const wrapThreshold = new Decimal(
      this.configService.mintPolicy?.wrapThresholdEth ?? 0.05,
    );
    const excessEth = balances.ethForGas.sub(wrapThreshold);

    if (excessEth.gt(0.001)) {
      this.logger.info('Wrapping excess native ETH to WETH', {
        ethForGas: balances.ethForGas.toFixed(6),
        excessEth: excessEth.toFixed(6),
        keepingForGas: wrapThreshold.toFixed(4),
      });

      try {
        const wrapTxHash = await this.walletService.wrapEth(excessEth);
        this.logger.info('ETH wrapped to WETH', {
          amount: excessEth.toFixed(6),
          txHash: wrapTxHash,
        });
        balances = await this.walletService.getBalances();
      } catch (error) {
        this.logger.warn('Failed to wrap ETH, continuing with available WETH', {
          error: (error as Error).message,
        });
      }
    }

    // Check minimum balance
    const totalValueUsdc = balances.weth
      .mul(rangeParams.poolState.spotPrice)
      .add(balances.usdc);
    if (totalValueUsdc.lt(50)) {
      this.logger.warn('Insufficient balance for LP creation', {
        totalValueUsdc: totalValueUsdc.toFixed(2),
        minRequired: 50,
      });
      await this.monitoringService.alertCritical(
        'Cannot create LP - insufficient balance',
        {
          component: 'App',
          totalValueUsdc: totalValueUsdc.toFixed(2),
          weth: balances.weth.toFixed(6),
          usdc: balances.usdc.toFixed(2),
        },
      );
      return false;
    }

    // Calculate optimal ratio and rebalance
    const { wethPercent: targetWethPercent } =
      await this.lpPositionService.calculateOptimalRatioForRange(
        rangeParams.tickLower,
        rangeParams.tickUpper,
        rangeParams.poolState.tick,
      );

    this.logger.info('Rebalancing wallet before LP creation', {
      targetWethPercent: targetWethPercent.toFixed(1) + '%',
      currentWeth: balances.weth.toFixed(6),
      currentUsdc: balances.usdc.toFixed(2),
    });

    const rebalanceResult = await this.walletService.rebalanceTo50_50({
      referencePrice: rangeParams.poolState.spotPrice,
      deviationThresholdPct: 0.02,
      maxSlippageBps: 100,
      deadlineSec: 600,
      minNotionalUsdc: 10,
      dryRun: false,
      targetWethPercent: targetWethPercent.toNumber(),
    });

    if (rebalanceResult.performed) {
      this.logger.info('Rebalance before LP creation complete', {
        direction: rebalanceResult.direction,
        amountIn: rebalanceResult.amountIn?.toFixed(6),
        txHash: rebalanceResult.txHash,
      });
    } else if (rebalanceResult.error) {
      this.logger.error('Rebalance before LP creation failed', undefined, {
        error: rebalanceResult.error,
        reason: rebalanceResult.reason,
      });
      await this.monitoringService.alertCritical(
        'Rebalance before LP creation failed',
        {
          component: 'App',
          error: rebalanceResult.error,
        },
      );
      return false;
    } else {
      this.logger.info('Rebalance not needed', {
        reason: rebalanceResult.reason,
      });
    }

    return true;
  }

  private async mintNewLpPosition(rangeParams: {
    tickLower: number;
    tickUpper: number;
    poolState: { spotPrice: Decimal };
  }): Promise<{ success: boolean; tokenId?: string }> {
    const mintResult = await this.lpPositionService.mintNewPositionForBudget({
      tickLower: rangeParams.tickLower,
      tickUpper: rangeParams.tickUpper,
      referencePrice: rangeParams.poolState.spotPrice,
    });

    if (!mintResult.success || !mintResult.newTokenId) {
      this.logger.warn('Failed to create LP position', {
        error: mintResult.error,
        reason: mintResult.reason,
      });
      await this.monitoringService.alertCritical('LP creation failed', {
        component: 'App',
        error: mintResult.error || mintResult.reason,
      });
      return { success: false };
    }

    const newTokenId = mintResult.newTokenId;
    await this.stateStore.setActiveTokenId(newTokenId);
    this.lpPositionService.setTokenId(newTokenId);

    this.logger.info('Successfully created new LP position', {
      tokenId: newTokenId,
      txHash: mintResult.txHash,
      usedUsdc: mintResult.usedUsdc.toFixed(2),
      usedWeth: mintResult.usedWeth.toFixed(6),
      liquidity: mintResult.liquidity?.toFixed(0),
    });

    await this.monitoringService.alertInfo('New LP position created', {
      component: 'App',
      tokenId: newTokenId,
      txHash: mintResult.txHash,
      usedUsdc: mintResult.usedUsdc.toFixed(2),
      usedWeth: mintResult.usedWeth.toFixed(6),
    });

    return { success: true, tokenId: newTokenId };
  }

  private async adjustHedgeForNewLp(
    tokenId: string,
    tickLower: number,
    tickUpper: number,
  ): Promise<void> {
    try {
      const poolState = await this.lpPositionService.getPoolState();
      const composition = await this.lpPositionService.getComposition(
        poolState.spotPrice,
      );
      const hedgeSnapshot = await this.hedgeService.getPosition();

      // Calculate target hedge
      const targetShortUsdc = this.strategyEngine.computeHedgeTarget(
        {
          wethAmount: composition.wethAmount,
          usdcAmount: composition.usdcAmount,
          totalValueUsdc: composition.totalValueUsdc,
          inRange: composition.inRange,
          tickLower,
          tickUpper,
          currentTick: poolState.tick,
          distanceToLowerPercent: composition.distanceToLowerPercent,
          distanceToUpperPercent: composition.distanceToUpperPercent,
        },
        poolState.spotPrice,
      );

      const hasExistingHedge =
        hedgeSnapshot.hasPosition && hedgeSnapshot.shortSizeEth.gt(0);
      const currentShortUsdc = hedgeSnapshot.shortNotionalUsdc;

      this.logger.info('Hedge check after LP creation', {
        hasExistingHedge,
        currentShortUsdc: currentShortUsdc.toFixed(2),
        targetShortUsdc: targetShortUsdc.toFixed(2),
        wethAmount: composition.wethAmount.toFixed(6),
      });

      // Check if rehedge is needed
      const diff = targetShortUsdc.sub(currentShortUsdc).abs();
      const minRehedgeAmount = new Decimal(
        this.configService.strategy?.minRehedgeAmountUsdc ??
          this.configService.hedgeExchange.minTradeNotional ??
          300,
      );

      if (diff.gte(minRehedgeAmount)) {
        const action = hasExistingHedge ? 'Rehedging' : 'Opening hedge';
        this.logger.info(`${action} for new LP position`, {
          currentShortUsdc: currentShortUsdc.toFixed(2),
          targetShortUsdc: targetShortUsdc.toFixed(2),
          diff: diff.toFixed(2),
        });

        const hedgeResult = await this.hedgeService.setTargetShortNotional(
          targetShortUsdc,
          HedgeUrgency.POST_RESET,
        );

        this.logger.info('Hedge adjusted for new LP', {
          executed: hedgeResult.executed,
          operation: hedgeResult.operation,
          deltaUsdc: hedgeResult.deltaUsdc.toFixed(2),
          avgPrice: hedgeResult.avgExecutionPrice.toFixed(2),
        });
      } else {
        this.logger.info('Hedge adjustment not needed - diff below minimum', {
          diff: diff.toFixed(2),
          minRehedgeAmount: minRehedgeAmount.toFixed(2),
        });
      }
    } catch (hedgeError) {
      this.logger.error(
        'Failed to adjust hedge for new LP',
        hedgeError as Error,
      );
      await this.monitoringService.alertWarn('Hedge not adjusted for new LP', {
        component: 'App',
        tokenId,
        error: (hedgeError as Error).message,
      });
      // Don't fail - LP is created, hedge will be adjusted in next cycle
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      this.logger.warn('Application is not running');
      return;
    }

    this.logger.info('Stopping Atlas Trading Bot...');
    this.isRunning = false;

    if (this.mainLoopTimer) {
      clearInterval(this.mainLoopTimer);
      this.mainLoopTimer = null;
    }

    // Execute shutdown handlers in reverse order
    for (const handler of this.shutdownHandlers.reverse()) {
      try {
        await handler();
      } catch (error) {
        this.logger.error('Error during shutdown', error as Error);
      }
    }

    this.logger.info('Atlas Trading Bot stopped');
  }

  private setupShutdownHandlers(): void {
    // Handle graceful shutdown on various signals
    process.on('SIGINT', this.gracefulShutdown.bind(this));
    process.on('SIGTERM', this.gracefulShutdown.bind(this));
    process.on('SIGUSR2', this.gracefulShutdown.bind(this)); // For nodemon

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      this.logger.error('Uncaught exception', error);
      this.gracefulShutdown();
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error(
        'Unhandled promise rejection',
        new Error(String(reason)),
        {
          promise: promise.toString(),
        },
      );
      this.gracefulShutdown();
    });
  }

  private async gracefulShutdown(): Promise<void> {
    this.logger.info('Received shutdown signal, gracefully shutting down...');

    try {
      // Добавляем таймаут для graceful shutdown
      const shutdownPromise = this.stop();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timeout')), 30000),
      );

      await Promise.race([shutdownPromise, timeoutPromise]);
      process.exit(0);
    } catch (error) {
      this.logger.error('Error during graceful shutdown', error as Error);
      process.exit(1);
    }
  }

  private addShutdownHandler(name: string, handler: () => Promise<void>): void {
    this.shutdownHandlers.push(async () => {
      try {
        this.logger.info(`Stopping ${name}...`);
        await handler();
        this.logger.info(`${name} stopped successfully`);
      } catch (error) {
        this.logger.error(`Failed to stop ${name}`, error as Error);
      }
    });
  }

  private startMainLoop(): void {
    if (this.mainLoopTimer) {
      this.logger.warn('Main loop already running');
      return;
    }

    const intervalSec = this.configService.loop?.loopIntervalSec ?? 60;
    this.logger.info('Starting main decision loop', { intervalSec });
    this.lastMainLoopAt = Date.now();

    this.mainLoopTimer = setInterval(() => {
      this.runMainLoopOnce().catch((error) => {
        this.logger.error('Main loop iteration failed', error as Error);
      });
    }, intervalSec * 1000);
  }

  /**
   * CEX Telemetry Loop (cheap, every 10 sec by default)
   * - Only CEX price + hedge snapshot
   * - No RPC calls
   * - Triggers DEX confirmation if near boundary
   * - Uses single-flight to prevent overlap
   */
  private startCexTelemetryLoop(): void {
    const intervalSec = this.configService.loop?.cexTelemetryIntervalSec ?? 10;
    const expression = `*/${intervalSec} * * * * *`;

    this.logger.info('Starting CEX telemetry loop', { intervalSec });

    this.schedulerService.scheduleJob(
      'telemetry.cex',
      expression,
      async () => {
        if (this.cexLoopRunning) return;
        this.cexLoopRunning = true;
        try {
          await this.runCexTelemetry();
        } catch (error) {
          this.logger.warn('CEX telemetry failed', {
            error: (error as Error).message,
          });
        } finally {
          this.cexLoopRunning = false;
        }
      },
      { timezone: 'UTC' },
    );
    this.schedulerService.startJob('telemetry.cex');
  }

  /**
   * Run cheap CEX-only telemetry
   */
  private async runCexTelemetry(): Promise<void> {
    this.lastCexTelemetryAt = Date.now();

    // Get CEX price (no RPC)
    const cexPrice = await this.priceService.getCexPriceOnly();

    // Get hedge snapshot (no RPC)
    const hedgeSnapshot = await this.hedgeService.getPosition();

    // Check against cached LP bounds
    const lpBounds = this.stateStore.getLpBoundsCache();
    if (!lpBounds) {
      // No cache - can't do cheap check
      return;
    }

    // Convert CEX price to approximate tick
    const approxTick = this.lpPositionService.priceToTick(cexPrice.price);

    // Check if near boundary using cached bounds
    const rangeCheck = this.stateStore.checkInRangeFromCache(approxTick);
    if (!rangeCheck) {
      return;
    }

    const resetThreshold =
      this.configService.strategy?.resetNearBoundaryPercent ?? 0.025;
    const thresholdPct = resetThreshold * 100; // Convert to percentage of range

    // Trigger DEX confirmation if:
    // 1. Out of range
    // 2. Within threshold of either boundary
    const needConfirm =
      !rangeCheck.inRange ||
      rangeCheck.distanceToLowerPercent < thresholdPct ||
      rangeCheck.distanceToUpperPercent < thresholdPct;

    if (needConfirm && !this.needDexConfirmation) {
      this.logger.info(
        'CEX telemetry: near boundary, triggering DEX confirmation',
        {
          approxTick,
          tickLower: lpBounds.tickLower,
          tickUpper: lpBounds.tickUpper,
          distanceToLower: rangeCheck.distanceToLowerPercent.toFixed(1) + '%',
          distanceToUpper: rangeCheck.distanceToUpperPercent.toFixed(1) + '%',
          inRange: rangeCheck.inRange,
        },
      );
      this.needDexConfirmation = true;
      this.dexConfirmRetries = 0; // Reset retry counter for new trigger
    }

    // Also check hedge margin (quick CEX-only check)
    if (hedgeSnapshot.hasPosition) {
      // Config is fraction (0.25 = 25%), liquidationDistancePercent is percentage (25.0)
      const dangerThresholdFraction =
        this.configService.risk?.dangerLiquidationDistancePercent ?? 0.25;
      const dangerThreshold = dangerThresholdFraction * 100; // Convert to percentage for comparison
      if (hedgeSnapshot.liquidationDistancePercent.lessThan(dangerThreshold)) {
        this.logger.warn(
          'CEX telemetry: hedge margin low, triggering full check',
          {
            liquidationDistance:
              hedgeSnapshot.liquidationDistancePercent.toFixed(1) + '%',
            dangerThreshold: dangerThreshold.toFixed(1) + '%',
          },
        );
        if (!this.needDexConfirmation) {
          this.needDexConfirmation = true;
          this.dexConfirmRetries = 0; // Reset retry counter for new trigger
        }
      }
    }
  }

  /**
   * DEX Confirmation Loop (every 60 sec OR on trigger)
   * - Reads only pool tick (single RPC call)
   * - Confirms boundary proximity using actual on-chain data
   * - Uses single-flight to prevent overlap
   */
  private startDexConfirmLoop(): void {
    const intervalSec = this.configService.loop?.dexConfirmIntervalSec ?? 60;
    const expression = `*/${intervalSec} * * * * *`;

    this.logger.info('Starting DEX confirmation loop', { intervalSec });

    this.schedulerService.scheduleJob(
      'telemetry.dex',
      expression,
      async () => {
        // Only run if triggered by CEX
        if (!this.needDexConfirmation) return;
        if (this.dexLoopRunning) return;

        this.dexLoopRunning = true;
        try {
          await this.runDexConfirmation();
          this.needDexConfirmation = false;
          this.dexConfirmRetries = 0; // Reset retry counter on success
        } catch (error) {
          this.dexConfirmRetries++;
          this.logger.warn('DEX confirmation failed', {
            error: (error as Error).message,
            retries: this.dexConfirmRetries,
            maxRetries: this.maxDexConfirmRetries,
          });

          // Reset flag after max retries to prevent infinite loop
          if (this.dexConfirmRetries >= this.maxDexConfirmRetries) {
            this.logger.error(
              'DEX confirmation max retries exceeded, resetting flag',
            );
            this.needDexConfirmation = false;
            this.dexConfirmRetries = 0;
          }
        } finally {
          this.dexLoopRunning = false;
        }
      },
      { timezone: 'UTC' },
    );
    this.schedulerService.startJob('telemetry.dex');
  }

  /**
   * Run DEX confirmation (single RPC call for slot0)
   */
  private async runDexConfirmation(): Promise<void> {
    this.lastDexConfirmAt = Date.now();

    // Get actual pool tick (single RPC)
    const poolTick = await this.lpPositionService.getPoolTick();

    // Check against cached bounds
    const lpBounds = this.stateStore.getLpBoundsCache();
    if (!lpBounds) {
      this.logger.debug('DEX confirmation: no LP bounds cache');
      return;
    }

    const rangeCheck = this.stateStore.checkInRangeFromCache(poolTick.tick);
    if (!rangeCheck) {
      return;
    }

    this.logger.debug('DEX confirmation', {
      tick: poolTick.tick,
      spotPrice: poolTick.spotPrice.toFixed(2),
      tickLower: lpBounds.tickLower,
      tickUpper: lpBounds.tickUpper,
      inRange: rangeCheck.inRange,
      distanceToLower: rangeCheck.distanceToLowerPercent.toFixed(1) + '%',
      distanceToUpper: rangeCheck.distanceToUpperPercent.toFixed(1) + '%',
    });

    // If out of range, let main loop handle it on next tick
    // Main loop will do full decision with complete data
  }

  /**
   * LP Bounds Reconciliation (every 15 min by default)
   * - Full position read from chain
   * - Updates cached bounds
   * - Uses single-flight to prevent overlap
   */
  private startLpBoundsReconcile(): void {
    const intervalMin =
      this.configService.loop?.lpBoundsReconcileIntervalMin ?? 15;
    const expression = `*/${intervalMin} * * * *`; // Every N minutes

    this.logger.info('Starting LP bounds reconciliation', { intervalMin });

    this.schedulerService.scheduleJob(
      'reconcile.lp_bounds',
      expression,
      async () => {
        if (this.reconcileLoopRunning) return;
        this.reconcileLoopRunning = true;
        try {
          await this.stateStore.refreshLpBounds();
        } catch (error) {
          this.logger.warn('LP bounds reconciliation failed', {
            error: (error as Error).message,
          });
        } finally {
          this.reconcileLoopRunning = false;
        }
      },
      { timezone: 'UTC' },
    );
    this.schedulerService.startJob('reconcile.lp_bounds');
  }

  /**
   * Dynamic Threshold Recalculation (every 30 min)
   * - Recalculates dynamic rehedge threshold based on current conditions
   * - Uses LP notional, volatility, and boundary distance
   */
  private startDynamicThresholdRecalculation(): void {
    // Skip if dynamic threshold is disabled
    if (!this.dynamicThresholdService.isEnabled()) {
      this.logger.info(
        'Dynamic threshold disabled, using static STRATEGY_REHEDGE_THRESHOLD',
      );
      return;
    }

    const cronExpression =
      this.configService.dynamicThreshold?.cronExpression || '*/30 * * * *';

    this.logger.info('Starting dynamic threshold recalculation', {
      cronExpression,
    });

    // Run once immediately on startup
    this.recalculateDynamicThreshold().catch((error) => {
      this.logger.warn('Initial dynamic threshold calculation failed', {
        error: (error as Error).message,
      });
    });

    this.schedulerService.scheduleJob(
      'strategy.dynamic_threshold',
      cronExpression,
      async () => {
        await this.recalculateDynamicThreshold();
      },
      { timezone: 'UTC' },
    );
    this.schedulerService.startJob('strategy.dynamic_threshold');
  }

  /**
   * Recalculate dynamic threshold with current market data
   */
  private async recalculateDynamicThreshold(): Promise<void> {
    try {
      // Get LP notional
      const activeTokenId = await this.stateStore.getActiveTokenId();
      if (!activeTokenId) {
        this.logger.debug(
          'No active LP position, skipping dynamic threshold recalculation',
        );
        return;
      }

      // Get reference price
      const referencePrice = await this.priceService.getReferencePrice();
      if (!referencePrice.isConsistent || referencePrice.sources.length === 0) {
        this.logger.warn(
          'Price not consistent, skipping dynamic threshold recalculation',
        );
        return;
      }

      // Use DEX price for LP composition (same as main loop)
      // DEX price is from Uniswap pool, same source as LP position
      const dexPrice = new Decimal(
        referencePrice.dexPrice ?? referencePrice.price,
      );

      // Get LP composition using DEX price for consistency
      const composition = await this.lpPositionService.getComposition(dexPrice);
      const lpNotionalUsdc = composition.totalValueUsdc;

      // Get volatility from range model
      const dynamicRange = await this.rangeModelService.calculateDynamicRange();
      const volatility24h = dynamicRange.volatility24h.div(100); // Convert from % to decimal

      // Get distance to boundary
      const distanceToBoundaryPct = Decimal.min(
        composition.distanceToLowerPercent,
        composition.distanceToUpperPercent,
      ).div(100); // Convert from % to decimal

      const isNearBoundary = distanceToBoundaryPct.lt(
        new Decimal(
          this.configService.strategy?.resetNearBoundaryPercent ?? 0.025,
        ),
      );

      // Get hedge cost estimate from Binance (real data)
      let estimatedHedgeCostUsdc: Decimal | undefined;
      const dynamicThresholdConfig = this.configService.dynamicThreshold;
      if (dynamicThresholdConfig?.enableCostFactor) {
        try {
          // Estimate cost for a typical rehedge (assume 5% of LP notional)
          const typicalRehedgeSize = lpNotionalUsdc.mul(0.05);
          estimatedHedgeCostUsdc =
            await this.hedgeService.estimateHedgeCost(typicalRehedgeSize);
        } catch (costError) {
          this.logger.warn('Failed to estimate hedge cost', {
            error: (costError as Error).message,
          });
        }
      }

      // LP daily fees from config (estimated value)
      const lpDailyFeesUsdc = dynamicThresholdConfig?.enableCostFactor
        ? new Decimal(dynamicThresholdConfig.lpDailyFeesEstimateUsdc ?? 5)
        : undefined;

      // Recalculate threshold
      const result = this.dynamicThresholdService.recalculate({
        lpNotionalUsdc,
        volatility24h,
        distanceToBoundaryPct,
        isNearBoundary,
        estimatedHedgeCostUsdc,
        lpDailyFeesUsdc,
      });

      this.logger.info('Dynamic threshold updated', {
        threshold: (result.threshold.toNumber() * 100).toFixed(2) + '%',
        lpNotional: '$' + lpNotionalUsdc.toFixed(0),
        vol24h: (volatility24h.toNumber() * 100).toFixed(2) + '%',
        distanceToBoundary:
          (distanceToBoundaryPct.toNumber() * 100).toFixed(2) + '%',
        isNearBoundary,
        ...(estimatedHedgeCostUsdc && {
          hedgeCost: '$' + estimatedHedgeCostUsdc.toFixed(2),
        }),
        ...(lpDailyFeesUsdc && {
          lpDailyFees: '$' + lpDailyFeesUsdc.toFixed(2),
        }),
      });
    } catch (error) {
      this.logger.error(
        'Dynamic threshold recalculation failed',
        error as Error,
      );
      // Don't throw - will use cached or fallback value
    }
  }

  private async runMainLoopOnce(): Promise<void> {
    if (this.mainLoopInProgress) {
      this.logger.warn('Main loop is already in progress, skipping this tick');
      return;
    }

    this.mainLoopInProgress = true;
    this.lastMainLoopAt = Date.now();

    try {
      const inFlight = await this.executionOrchestrator.getInFlightOperation();
      if (inFlight) {
        await this.executionOrchestrator.resume(inFlight);
        return;
      }

      const activeTokenId = await this.stateStore.getActiveTokenId();
      if (!activeTokenId) {
        this.logger.warn('No activeTokenId set; skipping main loop iteration');
        return;
      }

      this.lpPositionService.setTokenId(activeTokenId);

      const priceReference = await this.priceService.getReferencePrice();
      // Use DEX price for LP-related decisions (reset boundary checks)
      // DEX price is from Uniswap pool, same source as LP position
      // If DEX price unavailable, fall back to aggregated price
      const usedDexPrice = !!priceReference.dexPrice;
      // Normalize to Decimal for type safety - getComposition expects Decimal
      const referencePrice = new Decimal(
        priceReference.dexPrice ?? priceReference.price,
      );

      if (!usedDexPrice) {
        this.logger.warn(
          'DEX price unavailable, using aggregated price for LP decisions',
        );
      }

      const lpComposition =
        await this.lpPositionService.getComposition(referencePrice);
      const hedgeSnapshot = await this.hedgeService.getPosition();

      const riskFlags = await this.riskManager.evaluate({
        priceResult: {
          price: priceReference.price,
          isHealthy: priceReference.isConsistent,
          deviationPercent: priceReference.deviationPercent,
          source: 'aggregated',
        },
        lpComposition: {
          inRange: lpComposition.inRange,
          totalValueUsdc: lpComposition.totalValueUsdc,
          distanceToLowerPercent: lpComposition.distanceToLowerPercent,
          distanceToUpperPercent: lpComposition.distanceToUpperPercent,
        },
        hedgeSnapshot: {
          hasPosition: hedgeSnapshot.hasPosition,
          shortNotionalUsdc: hedgeSnapshot.shortNotionalUsdc,
          marginRatio: hedgeSnapshot.marginRatio,
          liquidationDistancePercent: hedgeSnapshot.liquidationDistancePercent,
          apiHealth: hedgeSnapshot.apiHealth,
        },
      });

      const plan = await this.strategyEngine.buildPlan(
        riskFlags,
        {
          wethAmount: lpComposition.wethAmount,
          usdcAmount: lpComposition.usdcAmount,
          totalValueUsdc: lpComposition.totalValueUsdc,
          inRange: lpComposition.inRange,
          currentTick: lpComposition.currentTick,
          tickLower: lpComposition.tickLower,
          tickUpper: lpComposition.tickUpper,
          distanceToLowerPercent: lpComposition.distanceToLowerPercent,
          distanceToUpperPercent: lpComposition.distanceToUpperPercent,
        },
        {
          hasPosition: hedgeSnapshot.hasPosition,
          shortNotionalUsdc: hedgeSnapshot.shortNotionalUsdc,
          shortSizeEth: hedgeSnapshot.shortSizeEth,
          markPrice: hedgeSnapshot.markPrice,
          equity: hedgeSnapshot.equity,
          liquidationDistancePercent: hedgeSnapshot.liquidationDistancePercent,
        },
        referencePrice,
        activeTokenId,
      );

      await this.executionOrchestrator.execute(plan);
    } finally {
      this.mainLoopInProgress = false;
    }
  }

  private startMonitoringJobs(): void {
    const { monitoring, loop } = this.configService;

    // All monitoring jobs use UTC for consistent business logic
    this.schedulerService.scheduleJob(
      'monitoring.health_check',
      monitoring.healthCheckExpression,
      async () => {
        const loopIntervalMs = (loop?.loopIntervalSec ?? 45) * 1000;
        const now = Date.now();
        const lastLoopAt = this.lastMainLoopAt;
        const loopLagMs = lastLoopAt ? now - lastLoopAt : undefined;
        const mainLoopStale =
          !lastLoopAt ||
          (loopLagMs !== undefined && loopLagMs > loopIntervalMs * 2);

        const dexHealth = await this.riskManager.checkDexHealth();
        const cexPingOk = await this.hedgeService.ping();

        if (dexHealth.status === 'critical') {
          await this.monitoringService.alertCritical(
            'RPC health check failed',
            {
              component: 'App',
              dexHealth,
            },
          );
        } else if (dexHealth.status === 'warning') {
          await this.monitoringService.alertWarn('RPC health warning', {
            component: 'App',
            dexHealth,
          });
        }

        if (!cexPingOk) {
          await this.monitoringService.alertWarn('CEX ping failed', {
            component: 'App',
          });
        }

        if (mainLoopStale) {
          await this.monitoringService.alertCritical(
            'Main loop appears stalled',
            {
              component: 'App',
              lastMainLoopAt: lastLoopAt,
              loopLagMs,
              loopIntervalSec: loop?.loopIntervalSec ?? 45,
            },
          );
        }
      },
      { timezone: 'UTC' },
    );
    this.schedulerService.startJob('monitoring.health_check');

    this.schedulerService.scheduleJob(
      'monitoring.position_sync',
      monitoring.positionSyncExpression,
      async () => {
        const activeTokenId = await this.stateStore.getActiveTokenId();
        const trackedTokenId = this.lpPositionService.getTokenId();

        if (!activeTokenId) {
          await this.monitoringService.alertWarn(
            'Position sync: activeTokenId is missing',
            {
              component: 'App',
            },
          );
          return;
        }

        if (trackedTokenId && trackedTokenId !== activeTokenId) {
          await this.monitoringService.alertWarn(
            'Position sync: tokenId mismatch',
            {
              component: 'App',
              activeTokenId,
              trackedTokenId,
            },
          );
        }

        try {
          await this.lpPositionService.getPositionById(activeTokenId);
        } catch (error) {
          await this.monitoringService.alertCritical(
            'Position sync: active tokenId not found on-chain',
            {
              component: 'App',
              activeTokenId,
              error: error as Error,
            },
          );
        }

        const latestTick = (await this.ledgerService.getTicks({ limit: 1 }))[0];

        if (latestTick?.lp.tokenId && latestTick.lp.tokenId !== activeTokenId) {
          await this.monitoringService.alertWarn(
            'Position sync: ledger tokenId mismatch',
            {
              component: 'App',
              activeTokenId,
              ledgerTokenId: latestTick.lp.tokenId,
            },
          );
        }

        if (latestTick) {
          // Skip hedge deviation check if there was a rehedge after the tick was recorded
          // Ticks are recorded on reset-range, rehedges happen independently
          const lastRehedgeAt = this.stateStore.getLastRehedgeAt();
          const tickTimestamp = latestTick.timestamp || 0;

          if (lastRehedgeAt && lastRehedgeAt > tickTimestamp) {
            // Rehedge happened after tick - deviation is expected, skip warning
          } else {
            const hedgeSnapshot = await this.hedgeService.getPosition();
            const currentShort = hedgeSnapshot.shortNotionalUsdc;
            const recordedShort = latestTick.hedge.shortNotionalUsdc;
            const threshold =
              this.configService.strategy?.rehedgeThresholdPercent ?? 0.2;
            const diff = currentShort.sub(recordedShort).abs();
            const denom = Decimal.max(recordedShort.abs(), new Decimal(1));
            const deviation = diff.div(denom);

            if (deviation.greaterThan(threshold)) {
              await this.monitoringService.alertWarn(
                'Position sync: hedge size deviation',
                {
                  component: 'App',
                  deviationPercent: deviation.mul(100).toFixed(2),
                  currentShort: currentShort.toFixed(2),
                  recordedShort: recordedShort.toFixed(2),
                  tickTimestamp,
                  lastRehedgeAt,
                  tickTokenId: latestTick.lp.tokenId,
                },
              );
            }
          }
        } else {
          this.logger.debug('Position sync: no ticks in ledger');
        }
      },
      { timezone: 'UTC' },
    );
    this.schedulerService.startJob('monitoring.position_sync');

    this.schedulerService.scheduleJob(
      'monitoring.funding_rate',
      monitoring.fundingRateCheckExpression,
      async () => {
        const fundingRate = await this.hedgeService.getFundingRate();
        const hedgeSnapshot = await this.hedgeService.getPosition();
        const positionSize = hedgeSnapshot.shortNotionalUsdc;
        const paymentUsdc = fundingRate.rate.mul(positionSize);

        await this.ledgerService.recordFunding({
          exchangeId: fundingRate.exchangeId,
          symbol: fundingRate.symbol,
          fundingRate: fundingRate.rate,
          positionSize,
          paymentUsdc,
        });
      },
      { timezone: 'UTC' },
    );
    this.schedulerService.startJob('monitoring.funding_rate');
  }

  // Utility methods for monitoring
  public async getStatus(): Promise<Record<string, unknown>> {
    return {
      isRunning: this.isRunning,
      config: {
        simulationMode: this.configService.isSimulationMode(),
        environment: this.configService.nodeEnv,
        pool: this.configService.getPoolPairSymbol(),
        chainId: this.configService.web3.chainId,
      },
      strategy: {
        rangeWidthPercent: this.configService.lpRange.rangeWidthPercent,
        rebalanceThreshold:
          this.configService.rebalance.rebalanceImbalanceThresholdPct,
      },
      hedgeExchange: {
        id: this.configService.hedgeExchange.id,
        symbol: this.configService.hedgeExchange.hedgeSymbol,
        leverage: this.configService.hedgeExchange.leverage,
      },
      margin: {
        minRatio: this.configService.margin.minMarginRatio,
        maxPositionSize: this.configService.margin.maxPositionSizeUsdc,
      },
      riskManager: {
        isMonitoring: this.riskManager.getState().isMonitoring,
        overallRiskLevel: this.riskManager.getState().overallRiskLevel,
        consecutiveFailures: this.riskManager.getState().consecutiveFailures,
        inEmergencyExit: this.riskManager.isInEmergencyExit(),
      },
    };
  }
}
