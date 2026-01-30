import { injectable, inject } from 'tsyringe';
import { v4 as uuidv4 } from 'uuid';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { EventBus } from '../../infra/event-bus/event-bus';
import { FeatureBuilder } from '../features/features.service';
import { MarketDataService } from '../market-data/market-data.service';
import { Features } from '../features/features.types';
import { ForcedEvent } from '../detectors/detector.types';
import {
  TradePlan,
  SetupResult,
  StallDetection,
  TradeSide,
  PlanStatus,
} from './setup-engine.types';
import {
  setupEventHandlers,
  EventHandler,
} from '../../infra/event-bus/event-bus.decorators';

interface PendingEvent {
  event: ForcedEvent;
  waitingSince: number;
  lastChecked: number;
}

@injectable()
export class SetupEngine {
  private readonly logger: ILogger;

  // Events waiting for stall/absorption confirmation
  private pendingEvents: Map<string, PendingEvent> = new Map();

  // Active trade plans
  private activePlans: Map<string, TradePlan> = new Map();

  // Check interval
  private checkIntervalId: NodeJS.Timeout | null = null;
  private readonly CHECK_INTERVAL_MS = 200; // Check every 200ms

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
    @inject(TOKENS.FEATURE_BUILDER) private featureBuilder: FeatureBuilder,
    @inject(TOKENS.MARKET_DATA_SERVICE) private marketData: MarketDataService,
  ) {
    this.logger = logger.child('SetupEngine');
    setupEventHandlers(this);
  }

  async start(): Promise<void> {
    this.logger.info('Starting SetupEngine...');

    // Start periodic check for stall conditions
    this.checkIntervalId = setInterval(() => {
      this.checkPendingEvents();
    }, this.CHECK_INTERVAL_MS);

    this.logger.info('SetupEngine started');
  }

  async stop(): Promise<void> {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
    this.pendingEvents.clear();
    this.activePlans.clear();
    this.logger.info('SetupEngine stopped');
  }

  @EventHandler('signal.classified')
  onSignalClassified(data: {
    event: ForcedEvent;
    passed: boolean;
    reason?: string;
  }): void {
    if (!data.passed) {
      return;
    }

    const { event } = data;
    const now = Date.now();

    // Check if we already have a pending event for this symbol
    if (this.pendingEvents.has(event.symbol)) {
      this.logger.debug('Already tracking event for symbol', {
        symbol: event.symbol,
      });
      return;
    }

    // Add to pending events
    this.pendingEvents.set(event.symbol, {
      event,
      waitingSince: now,
      lastChecked: now,
    });

    this.logger.info('🎯 Event queued for stall detection', {
      symbol: event.symbol,
      sideHint: event.sideHint,
      severity: event.severity.toFixed(2),
    });
  }

  private checkPendingEvents(): void {
    const now = Date.now();

    for (const [symbol, pending] of this.pendingEvents.entries()) {
      const elapsed = (now - pending.waitingSince) / 1000;

      // Check if expired
      if (elapsed > this.config.stall.waitMaxSec) {
        this.logger.debug('Event expired without stall', { symbol, elapsed });
        this.pendingEvents.delete(symbol);
        continue;
      }

      // Don't check until minimum wait time
      if (elapsed < this.config.stall.waitMinSec) {
        continue;
      }

      // Get current features
      const features = this.featureBuilder.getFeatures(symbol);
      if (!features) continue;

      // Check for stall/absorption
      const stallResult = this.detectStall(pending.event, features);

      if (stallResult.isStall) {
        // Create trade plan
        const plan = this.createTradePlan(pending.event, features, stallResult);

        if (plan) {
          this.activePlans.set(plan.id, plan);
          this.pendingEvents.delete(symbol);

          this.eventBus.emit('trade-plan.created', plan);

          this.logger.info('📋 Trade plan created', {
            id: plan.id,
            symbol: plan.symbol,
            side: plan.side,
            entry: plan.entryTriggerPrice.toFixed(2),
            stop: plan.stopPrice.toFixed(2),
            tp1: plan.tp1Price.toFixed(2),
          });
        }
      }

      pending.lastChecked = now;
    }
  }

  private detectStall(event: ForcedEvent, features: Features): StallDetection {
    const { snapshot } = event;

    // Basic stall criteria:
    // 1. Price range in last 10s is narrow (stall)
    const isFlat =
      features.stallRangePct10s <= this.config.stall.maxStallRangePct;

    // 2. Book replenishment is happening (absorption)
    const hasReplenish =
      features.bookReplenishScore10s >= this.config.stall.minReplenishScore;

    // 3. CVD divergence: aggressive flow continues but price doesn't move
    // For DOWN impulse (looking to go LONG): CVD should still be negative (selling continues)
    // For UP impulse (looking to go SHORT): CVD should still be positive (buying continues)
    let cvdDivergence = false;

    if (event.sideHint === 'DOWN') {
      // We want to go LONG after down impulse
      // CVD still negative = sellers still pressing, but price flat = absorption
      cvdDivergence = features.cvd30s < 0 && isFlat;
    } else {
      // We want to go SHORT after up impulse
      // CVD still positive = buyers still pressing, but price flat = absorption
      cvdDivergence = features.cvd30s > 0 && isFlat;
    }

    const isStall = isFlat && hasReplenish && cvdDivergence;

    // Calculate stall range from current features
    // In a real implementation, we'd track the actual high/low of the stall period
    const stallMid = features.px;
    const stallRange = stallMid * features.stallRangePct10s;
    const stallHigh = stallMid + stallRange / 2;
    const stallLow = stallMid - stallRange / 2;

    return {
      isStall,
      stallHigh,
      stallLow,
      rangePct: features.stallRangePct10s,
      replenishScore: features.bookReplenishScore10s,
      cvdDivergence,
    };
  }

  private createTradePlan(
    event: ForcedEvent,
    features: Features,
    stall: StallDetection,
  ): TradePlan | null {
    const side: TradeSide = event.sideHint === 'DOWN' ? 'LONG' : 'SHORT';

    // Calculate entry trigger
    const buffer = features.px * this.config.stall.breakoutBuffer;
    let entryTriggerPrice: number;
    let stopPrice: number;
    let impulseExtreme: number;

    if (side === 'LONG') {
      // Entry on breakout above stall high
      entryTriggerPrice = stall.stallHigh + buffer;
      // Stop below impulse low (from original event)
      impulseExtreme = event.snapshot.px; // This should ideally be the actual low
      stopPrice = impulseExtreme * (1 - this.config.exits.stopBuffer);
    } else {
      // Entry on breakout below stall low
      entryTriggerPrice = stall.stallLow - buffer;
      // Stop above impulse high
      impulseExtreme = event.snapshot.px; // This should ideally be the actual high
      stopPrice = impulseExtreme * (1 + this.config.exits.stopBuffer);
    }

    // Calculate risk per unit
    const riskPerUnit = Math.abs(entryTriggerPrice - stopPrice);
    if (riskPerUnit === 0) return null;

    // Calculate TP levels
    const tp1Price =
      side === 'LONG'
        ? entryTriggerPrice + riskPerUnit * this.config.exits.tp1MultR
        : entryTriggerPrice - riskPerUnit * this.config.exits.tp1MultR;

    const tp2Price =
      side === 'LONG'
        ? entryTriggerPrice + riskPerUnit * this.config.exits.tp2MultR
        : entryTriggerPrice - riskPerUnit * this.config.exits.tp2MultR;

    // Position sizing will be done by RiskManager - use placeholder here
    const placeholderQty = 0;
    const placeholderNotional = 0;

    const now = Date.now();

    const plan: TradePlan = {
      id: uuidv4(),
      eventId: event.id,
      symbol: event.symbol,
      side,
      entryTriggerPrice,
      entryType: 'STOP', // Use stop-market for breakout entry
      stopPrice,
      tp1Price,
      tp2Price,
      qty: placeholderQty,
      notionalUsdc: placeholderNotional,
      riskUsdc: 0,
      riskPercent: 0,
      stallHigh: stall.stallHigh,
      stallLow: stall.stallLow,
      impulseExtreme,
      createdAt: now,
      expiresAt: now + this.config.stall.waitMaxSec * 1000,
      status: 'PENDING',
    };

    return plan;
  }

  // ==================== Plan Management ====================

  getPlan(planId: string): TradePlan | undefined {
    return this.activePlans.get(planId);
  }

  getPlansBySymbol(symbol: string): TradePlan[] {
    return Array.from(this.activePlans.values()).filter(
      (p) => p.symbol === symbol,
    );
  }

  getAllPlans(): TradePlan[] {
    return Array.from(this.activePlans.values());
  }

  updatePlanStatus(planId: string, status: PlanStatus): void {
    const plan = this.activePlans.get(planId);
    if (!plan) return;

    plan.status = status;

    switch (status) {
      case 'ARMED':
        plan.armedAt = Date.now();
        this.eventBus.emit('trade-plan.armed', plan);
        break;
      case 'TRIGGERED':
        plan.triggeredAt = Date.now();
        this.eventBus.emit('trade-plan.triggered', plan);
        break;
      case 'FILLED':
        plan.filledAt = Date.now();
        this.eventBus.emit('trade-plan.filled', plan);
        break;
      case 'EXPIRED':
        this.eventBus.emit('trade-plan.expired', plan);
        this.activePlans.delete(planId);
        break;
      case 'CANCELLED':
        this.eventBus.emit('trade-plan.cancelled', {
          planId,
          reason: 'manual',
        });
        this.activePlans.delete(planId);
        break;
    }
  }

  cancelPlan(planId: string, reason: string): void {
    const plan = this.activePlans.get(planId);
    if (!plan) return;

    plan.status = 'CANCELLED';
    this.eventBus.emit('trade-plan.cancelled', { planId, reason });
    this.activePlans.delete(planId);
  }
}
