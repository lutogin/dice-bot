import { injectable, inject } from 'tsyringe';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { EventBus } from '../../infra/event-bus/event-bus';
import { BinanceClient } from '../../integrations/exchanges/binance/binance';
import { FeatureBuilder } from '../features/features.service';
import { TradePlan, TradeSide } from '../setup-engine/setup-engine.types';
import {
  setupEventHandlers,
  EventHandler,
} from '../../infra/event-bus/event-bus.decorators';
import { NormalizedTick } from '../market-data/market-data.types';

interface ActivePosition {
  planId: string;
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  triggerPrice: number; // Original trigger price for slippage calc
  qty: number;
  remainingQty: number; // Qty remaining after partial TPs
  stopPrice: number; // Current stop price (may be moved to breakeven)
  originalStopPrice: number; // Original stop for R calculation
  stopOrderId: string;
  tp1OrderId?: string;
  tp2OrderId?: string;
  openedAt: number;
  tp1Hit: boolean;
  // MAE/MFE tracking
  highestPrice: number;
  lowestPrice: number;
  totalFees: number;
  // Trailing stop
  trailActivated: boolean;
  trailStopPrice: number;
  // Time-based exits
  lastMfeCheckTime: number;
  mfeAtLastCheck: number;
}

// Time-stop and no-follow-through config
const TIME_STOP_CONFIG = {
  MAX_HOLD_WITHOUT_PROGRESS_MS: 5 * 60 * 1000, // 5 min max without progress
  MIN_MFE_FOR_PROGRESS: 0.2, // Need at least 0.2R MFE to consider "progress"
  NO_FOLLOW_THROUGH_MS: 60 * 1000, // 60 sec to show follow-through after entry
  NO_FOLLOW_THROUGH_MIN_MFE: 0.15, // Need 0.15R within first 60 sec
};

// Aggressive limit entry settings (maker-first, fallback to market)
const ENTRY_EXECUTION_CONFIG = {
  maxRetries: 2,
  retryIntervalMs: 300,
  fallbackToMarket: true,
  maxSlippagePct: 0.15,
  priceImprovementPct: 0.01,
};

@injectable()
export class ExecutionEngine {
  private readonly logger: ILogger;

  // Active positions being managed
  private positions: Map<string, ActivePosition> = new Map();

  // Armed plans waiting for trigger
  private armedPlans: Map<string, TradePlan> = new Map();

  // Check interval for armed plans
  private checkIntervalId: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 100;

  // Kill switch state
  private killSwitchActive = false;

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
    @inject(TOKENS.BINANCE_CLIENT) private binance: BinanceClient,
    @inject(TOKENS.FEATURE_BUILDER) private featureBuilder: FeatureBuilder,
  ) {
    this.logger = logger.child('ExecutionEngine');
    setupEventHandlers(this);
  }

  async start(): Promise<void> {
    this.logger.info('Starting ExecutionEngine...');

    this.checkIntervalId = setInterval(() => {
      this.checkArmedPlans();
    }, this.CHECK_INTERVAL_MS);

    this.logger.info('ExecutionEngine started');
  }

  async stop(): Promise<void> {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }

    // Cancel all armed plans
    for (const plan of this.armedPlans.values()) {
      await this.cancelPlan(plan.id, 'engine_shutdown');
    }

    this.armedPlans.clear();
    this.logger.info('ExecutionEngine stopped');
  }

  @EventHandler('tick.normalized')
  onTick(tick: NormalizedTick): void {
    // Update MAE/MFE for all positions of this symbol
    for (const position of this.positions.values()) {
      if (position.symbol !== tick.symbol) continue;

      // Update high/low tracking
      if (tick.price > position.highestPrice) {
        position.highestPrice = tick.price;
      }
      if (tick.price < position.lowestPrice) {
        position.lowestPrice = tick.price;
      }

      // Calculate current MFE in R
      const riskPerUnit = Math.abs(
        position.entryPrice - position.originalStopPrice,
      );
      const currentMfeR = this.calculateCurrentMfeR(
        position,
        tick.price,
        riskPerUnit,
      );

      // Check time-based exits (only if TP1 not hit yet)
      if (!position.tp1Hit) {
        this.checkTimeBasedExits(position, tick.price, currentMfeR);
      }

      // In simulation mode, check SL/TP hits
      if (this.config.isSimulation()) {
        this.checkSimulatedExits(position, tick.price);
      }

      // Check trailing stop if TP1 was hit
      if (position.tp1Hit) {
        this.checkTrailingStop(position, tick.price);
      }
    }
  }

  /**
   * Calculate current MFE in R multiples
   */
  private calculateCurrentMfeR(
    position: ActivePosition,
    currentPrice: number,
    riskPerUnit: number,
  ): number {
    if (riskPerUnit === 0) return 0;

    if (position.side === 'LONG') {
      return (position.highestPrice - position.entryPrice) / riskPerUnit;
    } else {
      return (position.entryPrice - position.lowestPrice) / riskPerUnit;
    }
  }

  /**
   * Check time-based exit conditions
   */
  private async checkTimeBasedExits(
    position: ActivePosition,
    currentPrice: number,
    currentMfeR: number,
  ): Promise<void> {
    const now = Date.now();
    const holdTimeMs = now - position.openedAt;
    const riskPerUnit = Math.abs(
      position.entryPrice - position.originalStopPrice,
    );

    // 1. No follow-through check (first 60 seconds)
    if (holdTimeMs <= TIME_STOP_CONFIG.NO_FOLLOW_THROUGH_MS) {
      // Still in follow-through window, just track
      return;
    }

    // After follow-through window: check if we ever got enough MFE
    if (
      holdTimeMs > TIME_STOP_CONFIG.NO_FOLLOW_THROUGH_MS &&
      holdTimeMs < TIME_STOP_CONFIG.NO_FOLLOW_THROUGH_MS + 5000
    ) {
      // Check once around 60-65 sec mark

      if (currentMfeR < TIME_STOP_CONFIG.NO_FOLLOW_THROUGH_MIN_MFE) {
        this.logger.info('⏱️ No follow-through - scratching position', {
          planId: position.planId,
          holdTimeSec: (holdTimeMs / 1000).toFixed(1),
          mfeR: currentMfeR.toFixed(2),
          requiredMfeR: TIME_STOP_CONFIG.NO_FOLLOW_THROUGH_MIN_MFE,
        });

        await this.closePosition(position.planId, 'TIME_STOP');
        return;
      }
    }

    // 2. Time stop: position dying in the water
    if (holdTimeMs > TIME_STOP_CONFIG.MAX_HOLD_WITHOUT_PROGRESS_MS) {
      // Check if we've made meaningful progress
      if (currentMfeR < TIME_STOP_CONFIG.MIN_MFE_FOR_PROGRESS) {
        // Calculate current P&L
        const currentPnlR =
          position.side === 'LONG'
            ? (currentPrice - position.entryPrice) / riskPerUnit
            : (position.entryPrice - currentPrice) / riskPerUnit;

        // Only scratch if we're near breakeven or small loss
        if (currentPnlR > -0.3) {
          // Within -0.3R
          this.logger.info('⏱️ Time stop - no progress, scratching', {
            planId: position.planId,
            holdTimeSec: (holdTimeMs / 1000).toFixed(1),
            mfeR: currentMfeR.toFixed(2),
            currentPnlR: currentPnlR.toFixed(2),
          });

          await this.closePosition(position.planId, 'TIME_STOP');
          return;
        }
      }
    }
  }

  /**
   * Check if SL or TP is hit in simulation mode
   */
  private async checkSimulatedExits(
    position: ActivePosition,
    currentPrice: number,
  ): Promise<void> {
    // Check stop loss
    if (position.side === 'LONG' && currentPrice <= position.stopPrice) {
      this.logger.info('🎮 [SIM] Stop loss hit', {
        planId: position.planId,
        stopPrice: position.stopPrice.toFixed(2),
        currentPrice: currentPrice.toFixed(2),
      });
      await this.closePosition(position.planId, 'SL');
      return;
    }
    if (position.side === 'SHORT' && currentPrice >= position.stopPrice) {
      this.logger.info('🎮 [SIM] Stop loss hit', {
        planId: position.planId,
        stopPrice: position.stopPrice.toFixed(2),
        currentPrice: currentPrice.toFixed(2),
      });
      await this.closePosition(position.planId, 'SL');
      return;
    }

    // Check TP1 (if not already hit)
    if (!position.tp1Hit) {
      const tp1Price = this.calculateTp1Price(position);
      if (position.side === 'LONG' && currentPrice >= tp1Price) {
        this.logger.info('🎮 [SIM] TP1 hit', {
          planId: position.planId,
          tp1Price: tp1Price.toFixed(2),
          currentPrice: currentPrice.toFixed(2),
        });
        await this.onTp1Hit(position.planId);
      } else if (position.side === 'SHORT' && currentPrice <= tp1Price) {
        this.logger.info('🎮 [SIM] TP1 hit', {
          planId: position.planId,
          tp1Price: tp1Price.toFixed(2),
          currentPrice: currentPrice.toFixed(2),
        });
        await this.onTp1Hit(position.planId);
      }
    }
  }

  private calculateTp1Price(position: ActivePosition): number {
    const riskPerUnit = Math.abs(
      position.entryPrice - position.originalStopPrice,
    );
    const tp1Distance = riskPerUnit * this.config.exits.tp1MultR;

    if (position.side === 'LONG') {
      return position.entryPrice + tp1Distance;
    } else {
      return position.entryPrice - tp1Distance;
    }
  }

  /**
   * Calculate realistic slippage based on market conditions
   * Slippage = a*spread + b*rv + c*(notional/depth) + noise
   */
  private calculateRealisticSlippage(plan: TradePlan): number {
    const features = this.featureBuilder.getFeatures(plan.symbol);

    // Base slippage components
    let slippage = 0;

    // 1. Spread component (50% of half-spread)
    const spreadComponent = features ? features.spreadPct * 0.5 : 0.0002;
    slippage += spreadComponent;

    // 2. Volatility component (higher vol = more slippage)
    const rvComponent = features ? features.rv30s * 0.3 : 0.0001;
    slippage += rvComponent;

    // 3. Impact component (larger orders = more slippage)
    // Simplified: assume $50k depth on each side
    const assumedDepth = 50000;
    const impactComponent = (plan.notionalUsdc / assumedDepth) * 0.001;
    slippage += Math.min(impactComponent, 0.002); // Cap at 0.2%

    // 4. Random noise (±20% of calculated slippage)
    const noise = (Math.random() - 0.5) * 0.4 * slippage;
    slippage += noise;

    // Clamp to reasonable bounds [0.01%, 0.5%]
    return Math.max(0.0001, Math.min(0.005, slippage));
  }

  @EventHandler('trade-plan.created')
  async onPlanCreated(plan: TradePlan): Promise<void> {
    if (this.killSwitchActive) {
      this.logger.warn('Kill switch active, ignoring plan', {
        planId: plan.id,
      });
      return;
    }

    // Check concurrent positions limit
    if (this.positions.size >= this.config.risk.maxConcurrentPositions) {
      this.logger.warn('Max concurrent positions reached', {
        current: this.positions.size,
        max: this.config.risk.maxConcurrentPositions,
      });
      this.eventBus.emit('trade-plan.cancelled', {
        planId: plan.id,
        reason: 'max_positions_reached',
      });
      return;
    }

    // Arm the plan
    this.armedPlans.set(plan.id, plan);
    plan.status = 'ARMED';
    plan.armedAt = Date.now();

    this.eventBus.emit('trade-plan.armed', plan);

    this.logger.info('📍 Plan armed', {
      planId: plan.id,
      symbol: plan.symbol,
      side: plan.side,
      trigger: plan.entryTriggerPrice.toFixed(2),
    });
  }

  private async checkArmedPlans(): Promise<void> {
    if (this.killSwitchActive) return;

    const now = Date.now();

    for (const [planId, plan] of this.armedPlans.entries()) {
      // Check expiration
      if (now > plan.expiresAt) {
        this.logger.debug('Plan expired', { planId });
        this.armedPlans.delete(planId);
        this.eventBus.emit('trade-plan.expired', plan);
        continue;
      }

      // Check trigger condition
      const triggered = await this.checkTrigger(plan);

      if (triggered) {
        await this.executeEntry(plan);
        this.armedPlans.delete(planId);
      }
    }
  }

  private async checkTrigger(plan: TradePlan): Promise<boolean> {
    try {
      const price = await this.binance.getCurrentPrice(plan.symbol);
      const currentPrice = price.toNumber();

      if (plan.side === 'LONG') {
        // Trigger on breakout above entry price
        return currentPrice >= plan.entryTriggerPrice;
      } else {
        // Trigger on breakout below entry price
        return currentPrice <= plan.entryTriggerPrice;
      }
    } catch (error) {
      this.logger.error('Error checking trigger', error as Error);
      return false;
    }
  }

  private async executeEntry(plan: TradePlan): Promise<void> {
    try {
      plan.status = 'TRIGGERED';
      plan.triggeredAt = Date.now();
      this.eventBus.emit('trade-plan.triggered', plan);

      const orderSide = plan.side === 'LONG' ? 'BUY' : 'SELL';

      let entryPrice: number;
      let filledQty: number;
      let entryFees: number;
      let stopOrderId: string;
      let tp1OrderId: string;

      if (this.config.isSimulation()) {
        // SIMULATION MODE - paper trading with realistic slippage model
        // Slippage = f(spread, volatility, impact)
        const simulatedSlippage = this.calculateRealisticSlippage(plan);

        // Apply slippage in direction of entry
        if (plan.side === 'LONG') {
          entryPrice = plan.entryTriggerPrice * (1 + simulatedSlippage);
        } else {
          entryPrice = plan.entryTriggerPrice * (1 - simulatedSlippage);
        }

        filledQty = plan.qty;
        entryFees = entryPrice * filledQty * 0.0004; // Simulate 0.04% taker fee
        stopOrderId = `SIM-SL-${Date.now()}`;
        tp1OrderId = `SIM-TP1-${Date.now()}`;

        this.logger.info('🎮 [SIM] Entry filled', {
          planId: plan.id,
          symbol: plan.symbol,
          side: plan.side,
          triggerPrice: plan.entryTriggerPrice.toFixed(2),
          fillPrice: entryPrice.toFixed(2),
          slippageBps: (simulatedSlippage * 10000).toFixed(1),
          qty: filledQty.toFixed(4),
        });
      } else {
        // LIVE MODE - real orders
        const result = await this.binance.createAggressiveLimitOrder(
          plan.symbol,
          orderSide,
          plan.qty,
          ENTRY_EXECUTION_CONFIG,
        );

        if (result.filledQty === 0) {
          this.logger.error('Entry order failed', null, { planId: plan.id });
          return;
        }

        entryPrice = result.avgPrice;
        filledQty = result.filledQty;
        entryFees = result.fees || 0;

        // Place stop-loss order
        const stopSide = plan.side === 'LONG' ? 'SELL' : 'BUY';
        const stopResult = await this.binance.createStopMarketOrder(
          plan.symbol,
          stopSide,
          filledQty,
          plan.stopPrice,
        );
        stopOrderId = stopResult.orderId;

        // Place TP1 order
        const tp1Result = await this.binance.createTakeProfitOrder(
          plan.symbol,
          stopSide,
          filledQty * this.config.exits.tp1ClosePct,
          plan.tp1Price,
        );
        tp1OrderId = tp1Result.orderId;

        this.logger.info('✅ Entry filled', {
          planId: plan.id,
          symbol: plan.symbol,
          side: plan.side,
          fillPrice: entryPrice.toFixed(2),
          qty: filledQty.toFixed(4),
          marketFallback: result.usedMarketFallback,
        });
      }

      // Calculate slippage
      const slippageUsdc =
        Math.abs(entryPrice - plan.entryTriggerPrice) * filledQty;
      const slippagePct =
        Math.abs(entryPrice - plan.entryTriggerPrice) / plan.entryTriggerPrice;

      this.logger.info(
        this.config.isSimulation()
          ? '🎮 [SIM] Position opened'
          : '✅ Position opened',
        {
          planId: plan.id,
          symbol: plan.symbol,
          side: plan.side,
          triggerPrice: plan.entryTriggerPrice.toFixed(2),
          fillPrice: entryPrice.toFixed(2),
          slippage:
            slippagePct > 0 ? (slippagePct * 100).toFixed(3) + '%' : '0%',
          qty: filledQty.toFixed(4),
          fees: entryFees.toFixed(4),
        },
      );

      // Create active position with MAE/MFE tracking
      const now = Date.now();
      const position: ActivePosition = {
        planId: plan.id,
        symbol: plan.symbol,
        side: plan.side,
        entryPrice,
        triggerPrice: plan.entryTriggerPrice,
        qty: filledQty,
        remainingQty: filledQty,
        stopPrice: plan.stopPrice,
        originalStopPrice: plan.stopPrice,
        stopOrderId,
        tp1OrderId,
        openedAt: now,
        tp1Hit: false,
        highestPrice: entryPrice,
        lowestPrice: entryPrice,
        totalFees: entryFees,
        trailActivated: false,
        trailStopPrice: plan.stopPrice,
        // Time-based exit tracking
        lastMfeCheckTime: now,
        mfeAtLastCheck: 0,
      };

      this.positions.set(plan.id, position);

      plan.status = 'FILLED';
      plan.filledAt = Date.now();
      this.eventBus.emit('trade-plan.filled', plan);

      this.eventBus.emit('position.opened', {
        planId: plan.id,
        symbol: plan.symbol,
        side: plan.side,
        entryPrice,
        triggerPrice: plan.entryTriggerPrice,
        qty: filledQty,
        notionalUsdc: entryPrice * filledQty,
        slippageUsdc,
        feesUsdc: entryFees,
        simulation: this.config.isSimulation(),
      });
    } catch (error) {
      this.logger.error('Error executing entry', error as Error, {
        planId: plan.id,
      });

      // Cleanup on failure (only in live mode)
      if (!this.config.isSimulation()) {
        try {
          await this.binance.cancelAllOrders(plan.symbol);
        } catch (cancelError) {
          this.logger.error(
            'Error canceling orders after failed entry',
            cancelError as Error,
          );
        }
      }
    }
  }

  // ==================== TP1 Hit Handler ====================

  /**
   * Called when TP1 is hit - moves stop to breakeven and activates trailing
   */
  async onTp1Hit(planId: string): Promise<void> {
    const position = this.positions.get(planId);
    if (!position || position.tp1Hit) return;

    position.tp1Hit = true;
    position.remainingQty = position.qty * (1 - this.config.exits.tp1ClosePct);

    // Add partial TP1 fees
    const tp1Qty = position.qty * this.config.exits.tp1ClosePct;
    const tp1Price = this.calculateTp1Price(position);
    position.totalFees += tp1Price * tp1Qty * 0.0004; // 0.04% fee

    this.logger.info(
      this.config.isSimulation()
        ? '🎮 [SIM] TP1 hit - moving stop to breakeven'
        : '🎯 TP1 hit - moving stop to breakeven',
      {
        planId,
        symbol: position.symbol,
        entryPrice: position.entryPrice.toFixed(2),
      },
    );

    // Calculate breakeven price (entry + small buffer for fees)
    const feeBuffer = position.entryPrice * 0.0002; // 0.02% buffer
    const breakevenPrice =
      position.side === 'LONG'
        ? position.entryPrice + feeBuffer
        : position.entryPrice - feeBuffer;

    if (this.config.isSimulation()) {
      // SIMULATION - just update the stop price
      position.stopOrderId = `SIM-SL-BE-${Date.now()}`;
      position.stopPrice = breakevenPrice;
      position.trailStopPrice = breakevenPrice;
    } else {
      // LIVE - cancel and replace stop order
      try {
        await this.binance.cancelOrder(position.symbol, position.stopOrderId);

        const stopSide = position.side === 'LONG' ? 'SELL' : 'BUY';
        const newStop = await this.binance.createStopMarketOrder(
          position.symbol,
          stopSide,
          position.remainingQty,
          breakevenPrice,
        );

        position.stopOrderId = newStop.orderId;
        position.stopPrice = breakevenPrice;
        position.trailStopPrice = breakevenPrice;
      } catch (error) {
        this.logger.error('Error moving stop to breakeven', error as Error, {
          planId,
        });
        return;
      }
    }

    this.eventBus.emit('position.stop-moved', {
      planId,
      symbol: position.symbol,
      oldStop: position.originalStopPrice,
      newStop: breakevenPrice,
      reason: 'tp1_hit',
      simulation: this.config.isSimulation(),
    });
  }

  /**
   * Check and update trailing stop
   */
  private async checkTrailingStop(
    position: ActivePosition,
    currentPrice: number,
  ): Promise<void> {
    const riskPerUnit = Math.abs(
      position.entryPrice - position.originalStopPrice,
    );
    const currentR =
      position.side === 'LONG'
        ? (currentPrice - position.entryPrice) / riskPerUnit
        : (position.entryPrice - currentPrice) / riskPerUnit;

    // Activate trailing if we've reached the activation threshold
    if (
      !position.trailActivated &&
      currentR >= this.config.exits.trailActivateR
    ) {
      position.trailActivated = true;
      this.logger.info(
        this.config.isSimulation()
          ? '🎮 [SIM] Trailing stop activated'
          : '📈 Trailing stop activated',
        {
          planId: position.planId,
          currentR: currentR.toFixed(2),
        },
      );
    }

    if (!position.trailActivated) return;

    // Calculate new trail stop based on recent price action
    // Trail at 0.5R behind the best price
    const trailDistance = riskPerUnit * 0.5;
    let newTrailStop: number;

    if (position.side === 'LONG') {
      newTrailStop = position.highestPrice - trailDistance;
      // Only move stop up, never down
      if (newTrailStop <= position.trailStopPrice) return;
    } else {
      newTrailStop = position.lowestPrice + trailDistance;
      // Only move stop down, never up
      if (newTrailStop >= position.trailStopPrice) return;
    }

    // Don't update too frequently - minimum 0.1% move
    const minMove = position.entryPrice * 0.001;
    if (Math.abs(newTrailStop - position.trailStopPrice) < minMove) return;

    const oldStop = position.trailStopPrice;

    if (this.config.isSimulation()) {
      // SIMULATION - just update the price
      position.stopOrderId = `SIM-TRAIL-${Date.now()}`;
      position.stopPrice = newTrailStop;
      position.trailStopPrice = newTrailStop;
    } else {
      // LIVE - cancel and replace
      try {
        await this.binance.cancelOrder(position.symbol, position.stopOrderId);

        const stopSide = position.side === 'LONG' ? 'SELL' : 'BUY';
        const newStop = await this.binance.createStopMarketOrder(
          position.symbol,
          stopSide,
          position.remainingQty,
          newTrailStop,
        );

        position.stopOrderId = newStop.orderId;
        position.stopPrice = newTrailStop;
        position.trailStopPrice = newTrailStop;
      } catch (error) {
        this.logger.error('Error updating trailing stop', error as Error, {
          planId: position.planId,
        });
        return;
      }
    }

    this.logger.debug('Trailing stop updated', {
      planId: position.planId,
      oldStop: oldStop.toFixed(2),
      newStop: newTrailStop.toFixed(2),
      currentR: currentR.toFixed(2),
    });

    this.eventBus.emit('position.stop-moved', {
      planId: position.planId,
      symbol: position.symbol,
      oldStop,
      newStop: newTrailStop,
      reason: 'trailing',
      simulation: this.config.isSimulation(),
    });
  }

  // ==================== Position Management ====================

  async closePosition(
    planId: string,
    reason: 'TP' | 'SL' | 'MANUAL' | 'KILL_SWITCH' | 'TIME_STOP',
  ): Promise<void> {
    const position = this.positions.get(planId);
    if (!position) {
      this.logger.warn('Position not found', { planId });
      return;
    }

    let exitPrice: number;
    let exitFees: number;

    if (this.config.isSimulation()) {
      // SIMULATION - use current stop/tp price as exit
      if (reason === 'SL') {
        exitPrice = position.stopPrice;
      } else {
        // For TP or manual, use the best price achieved
        exitPrice =
          position.side === 'LONG'
            ? position.highestPrice
            : position.lowestPrice;
      }
      exitFees = exitPrice * position.remainingQty * 0.0004; // 0.04% fee
    } else {
      // LIVE - execute real close
      try {
        // Cancel any pending orders
        await this.binance.cancelAllOrders(position.symbol);

        // Get remaining position
        const posData = await this.binance.getPosition(position.symbol);
        if (!posData || Math.abs(posData.qty) < 0.0001) {
          this.logger.info('Position already closed', { planId });
          this.positions.delete(planId);
          return;
        }

        // Close position at market
        const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';
        const result = await this.binance.createMarketOrder(
          position.symbol,
          closeSide,
          Math.abs(posData.qty),
        );

        exitPrice = result.avgPrice;
        exitFees = result.fees || 0;
      } catch (error) {
        this.logger.error('Error closing position', error as Error, { planId });
        return;
      }
    }

    const totalFees = position.totalFees + exitFees;

    // Calculate P&L
    const pnlUsdc =
      position.side === 'LONG'
        ? (exitPrice - position.entryPrice) * position.remainingQty - totalFees
        : (position.entryPrice - exitPrice) * position.remainingQty - totalFees;

    // Add TP1 profit if it was hit
    let totalPnlUsdc = pnlUsdc;
    if (position.tp1Hit) {
      const tp1Qty = position.qty * this.config.exits.tp1ClosePct;
      const tp1Price = this.calculateTp1Price(position);
      const tp1Pnl =
        position.side === 'LONG'
          ? (tp1Price - position.entryPrice) * tp1Qty
          : (position.entryPrice - tp1Price) * tp1Qty;
      totalPnlUsdc += tp1Pnl;
    }

    // Calculate P&L in R (risk multiples) using original stop
    const riskPerUnit = Math.abs(
      position.entryPrice - position.originalStopPrice,
    );
    const riskUsdc = riskPerUnit * position.qty;
    const pnlR = riskUsdc > 0 ? totalPnlUsdc / riskUsdc : 0;

    // Calculate MAE/MFE as percentages
    let mfe: number;
    let mae: number;

    if (position.side === 'LONG') {
      mfe = (position.highestPrice - position.entryPrice) / position.entryPrice;
      mae = (position.entryPrice - position.lowestPrice) / position.entryPrice;
    } else {
      mfe = (position.entryPrice - position.lowestPrice) / position.entryPrice;
      mae = (position.highestPrice - position.entryPrice) / position.entryPrice;
    }

    // Calculate slippage
    const entrySlippage =
      Math.abs(position.entryPrice - position.triggerPrice) * position.qty;
    const slippageUsdc = entrySlippage;

    this.eventBus.emit('position.closed', {
      planId,
      symbol: position.symbol,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice,
      qty: position.qty,
      pnlUsdc: totalPnlUsdc,
      pnlR,
      reason,
      feesUsdc: totalFees,
      slippageUsdc,
      mfe,
      mae,
      holdTimeMs: Date.now() - position.openedAt,
      simulation: this.config.isSimulation(),
    });

    this.logger.info(
      this.config.isSimulation()
        ? '🎮 [SIM] Position closed'
        : '📊 Position closed',
      {
        planId,
        symbol: position.symbol,
        pnlUsdc: totalPnlUsdc.toFixed(2),
        pnlR: pnlR.toFixed(2) + 'R',
        mfe: (mfe * 100).toFixed(2) + '%',
        mae: (mae * 100).toFixed(2) + '%',
        fees: totalFees.toFixed(4),
        reason,
      },
    );

    this.positions.delete(planId);
  }

  async cancelPlan(planId: string, reason: string): Promise<void> {
    const plan = this.armedPlans.get(planId);
    if (!plan) return;

    this.armedPlans.delete(planId);
    this.eventBus.emit('trade-plan.cancelled', { planId, reason });

    this.logger.info('Plan cancelled', { planId, reason });
  }

  // ==================== Kill Switch ====================

  async activateKillSwitch(): Promise<void> {
    this.killSwitchActive = true;
    this.logger.warn('🛑 KILL SWITCH ACTIVATED');

    this.eventBus.emit('risk.trading-halted', {
      reason: 'kill_switch_manual',
      timestamp: Date.now(),
    });

    // Cancel all armed plans
    for (const plan of this.armedPlans.values()) {
      await this.cancelPlan(plan.id, 'kill_switch');
    }

    // Close all positions
    for (const planId of this.positions.keys()) {
      await this.closePosition(planId, 'KILL_SWITCH');
    }
  }

  deactivateKillSwitch(): void {
    this.killSwitchActive = false;
    this.logger.info('Kill switch deactivated');

    this.eventBus.emit('risk.trading-resumed', {
      timestamp: Date.now(),
    });
  }

  isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  // ==================== Getters ====================

  getPosition(planId: string): ActivePosition | undefined {
    return this.positions.get(planId);
  }

  getAllPositions(): ActivePosition[] {
    return Array.from(this.positions.values());
  }

  getArmedPlans(): TradePlan[] {
    return Array.from(this.armedPlans.values());
  }
}
