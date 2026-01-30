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
  checkCount: number;
  // Track why we haven't entered yet
  lastRejectReasons: string[];
  // Track price action since event
  priceAtEvent: number;
  highSinceEvent: number;
  lowSinceEvent: number;
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
  private readonly CHECK_INTERVAL_MS = 200;

  // Adaptive threshold multipliers
  private readonly STALL_RV_MULTIPLIER = 1.5; // stallThreshold = rv30s * multiplier
  private readonly MIN_STALL_RANGE_PCT = 0.0005; // 0.05% floor
  private readonly MAX_STALL_RANGE_PCT = 0.003; // 0.3% ceiling

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

    this.checkIntervalId = setInterval(() => {
      this.checkPendingEvents();
    }, this.CHECK_INTERVAL_MS);

    this.logger.info('SetupEngine started', {
      stallRvMultiplier: this.STALL_RV_MULTIPLIER,
      minStallRange: (this.MIN_STALL_RANGE_PCT * 100).toFixed(2) + '%',
      maxStallRange: (this.MAX_STALL_RANGE_PCT * 100).toFixed(2) + '%',
    });
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

    if (this.pendingEvents.has(event.symbol)) {
      this.logger.debug('Already tracking event for symbol', {
        symbol: event.symbol,
      });
      return;
    }

    const currentPrice = event.snapshot.px;

    this.pendingEvents.set(event.symbol, {
      event,
      waitingSince: now,
      lastChecked: now,
      checkCount: 0,
      lastRejectReasons: [],
      priceAtEvent: currentPrice,
      highSinceEvent: currentPrice,
      lowSinceEvent: currentPrice,
    });

    this.logger.info('🎯 Event queued for stall detection', {
      symbol: event.symbol,
      sideHint: event.sideHint,
      severity: event.severity.toFixed(2),
      priceAtEvent: currentPrice.toFixed(2),
    });
  }

  private checkPendingEvents(): void {
    const now = Date.now();

    for (const [symbol, pending] of this.pendingEvents.entries()) {
      const elapsed = (now - pending.waitingSince) / 1000;
      pending.checkCount++;

      // Get current features
      const features = this.featureBuilder.getFeatures(symbol);
      if (!features) continue;

      // Update price tracking
      if (features.px > pending.highSinceEvent) {
        pending.highSinceEvent = features.px;
      }
      if (features.px < pending.lowSinceEvent) {
        pending.lowSinceEvent = features.px;
      }

      // Check if expired (continuation filter)
      if (elapsed > this.config.stall.waitMaxSec) {
        this.logSetupExpired(pending, features, elapsed);
        this.pendingEvents.delete(symbol);
        continue;
      }

      // Don't check until minimum wait time
      if (elapsed < this.config.stall.waitMinSec) {
        continue;
      }

      // Check for continuation (no stall forming)
      const continuationCheck = this.checkContinuation(pending, features);
      if (continuationCheck.isContinuation) {
        this.logContinuationDetected(
          pending,
          features,
          continuationCheck.reasons,
        );
        this.pendingEvents.delete(symbol);
        continue;
      }

      // Check for stall/absorption
      const stallResult = this.detectStall(pending.event, features);

      if (stallResult.isStall) {
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
            waitedSec: elapsed.toFixed(1),
            adaptiveStallThreshold:
              (stallResult.adaptiveThreshold * 100).toFixed(3) + '%',
          });
        }
      } else {
        // Log why we're not entering yet (every 10 checks = ~2 sec)
        if (pending.checkCount % 10 === 0) {
          pending.lastRejectReasons = stallResult.rejectReasons;
          this.logger.debug('Stall not confirmed yet', {
            symbol,
            elapsed: elapsed.toFixed(1) + 's',
            reasons: stallResult.rejectReasons,
            stallRange: (features.stallRangePct10s * 100).toFixed(3) + '%',
            threshold: (stallResult.adaptiveThreshold * 100).toFixed(3) + '%',
            replenish: features.bookReplenishScore10s.toFixed(2),
          });
        }
      }

      pending.lastChecked = now;
    }
  }

  /**
   * Check for continuation pattern (trend day, not exhaustion)
   */
  private checkContinuation(
    pending: PendingEvent,
    features: Features,
  ): { isContinuation: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const { event } = pending;

    // Price continues making new extremes in impulse direction
    if (event.sideHint === 'DOWN') {
      // For down impulse, continuation = price keeps making lower lows
      const newLowPct =
        (pending.lowSinceEvent - pending.priceAtEvent) / pending.priceAtEvent;
      if (newLowPct < -0.01) {
        // More than 1% lower than event price
        reasons.push(`price_continuing_down_${(newLowPct * 100).toFixed(2)}%`);
      }
    } else {
      // For up impulse, continuation = price keeps making higher highs
      const newHighPct =
        (pending.highSinceEvent - pending.priceAtEvent) / pending.priceAtEvent;
      if (newHighPct > 0.01) {
        reasons.push(`price_continuing_up_${(newHighPct * 100).toFixed(2)}%`);
      }
    }

    // CVD and price aligned (no divergence = continuation)
    const cvdAligned =
      (event.sideHint === 'DOWN' &&
        features.cvd30s < 0 &&
        features.ret30s < -0.002) ||
      (event.sideHint === 'UP' &&
        features.cvd30s > 0 &&
        features.ret30s > 0.002);

    if (cvdAligned) {
      reasons.push('cvd_price_aligned_continuation');
    }

    // Spread widening (market stress continuing)
    if (features.spreadPct > 0.002) {
      reasons.push(`spread_widening_${(features.spreadPct * 100).toFixed(2)}%`);
    }

    // Book replenish weak (no absorption)
    if (features.bookReplenishScore10s < 0.3) {
      reasons.push(
        `weak_replenish_${features.bookReplenishScore10s.toFixed(2)}`,
      );
    }

    // Need at least 2 continuation signals to abort
    return {
      isContinuation: reasons.length >= 2,
      reasons,
    };
  }

  /**
   * Detect stall with ADAPTIVE threshold based on current volatility
   */
  private detectStall(
    event: ForcedEvent,
    features: Features,
  ): StallDetection & {
    rejectReasons: string[];
    adaptiveThreshold: number;
  } {
    const rejectReasons: string[] = [];

    // Calculate adaptive stall threshold based on current volatility
    // Higher volatility = wider acceptable stall range
    const adaptiveThreshold = Math.max(
      this.MIN_STALL_RANGE_PCT,
      Math.min(
        this.MAX_STALL_RANGE_PCT,
        features.rv30s * this.STALL_RV_MULTIPLIER,
      ),
    );

    // 1. Price range check with adaptive threshold
    const isFlat = features.stallRangePct10s <= adaptiveThreshold;
    if (!isFlat) {
      rejectReasons.push(
        `range_too_wide:${(features.stallRangePct10s * 100).toFixed(3)}%>${(adaptiveThreshold * 100).toFixed(3)}%`,
      );
    }

    // 2. Book replenishment (absorption)
    const hasReplenish =
      features.bookReplenishScore10s >= this.config.stall.minReplenishScore;
    if (!hasReplenish) {
      rejectReasons.push(
        `low_replenish:${features.bookReplenishScore10s.toFixed(2)}<${this.config.stall.minReplenishScore}`,
      );
    }

    // 3. CVD divergence (flow exhaustion signal)
    let cvdDivergence = false;
    if (event.sideHint === 'DOWN') {
      // For down impulse, want CVD turning positive (buyers stepping in)
      cvdDivergence = features.cvd30s > 0;
      if (!cvdDivergence) {
        rejectReasons.push(
          `no_cvd_divergence:cvd=${features.cvd30s.toFixed(0)}`,
        );
      }
    } else {
      // For up impulse, want CVD turning negative (sellers stepping in)
      cvdDivergence = features.cvd30s < 0;
      if (!cvdDivergence) {
        rejectReasons.push(
          `no_cvd_divergence:cvd=${features.cvd30s.toFixed(0)}`,
        );
      }
    }

    const isStall = isFlat && hasReplenish && cvdDivergence;

    // Calculate stall range
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
      rejectReasons,
      adaptiveThreshold,
    };
  }

  private createTradePlan(
    event: ForcedEvent,
    features: Features,
    stall: StallDetection,
  ): TradePlan | null {
    const side: TradeSide = event.sideHint === 'DOWN' ? 'LONG' : 'SHORT';

    const buffer = features.px * this.config.stall.breakoutBuffer;
    let entryTriggerPrice: number;
    let stopPrice: number;
    let impulseExtreme: number;

    if (side === 'LONG') {
      entryTriggerPrice = stall.stallHigh + buffer;
      impulseExtreme = event.snapshot.px;
      stopPrice = impulseExtreme * (1 - this.config.exits.stopBuffer);
    } else {
      entryTriggerPrice = stall.stallLow - buffer;
      impulseExtreme = event.snapshot.px;
      stopPrice = impulseExtreme * (1 + this.config.exits.stopBuffer);
    }

    const riskPerUnit = Math.abs(entryTriggerPrice - stopPrice);
    if (riskPerUnit === 0) return null;

    const tp1Price =
      side === 'LONG'
        ? entryTriggerPrice + riskPerUnit * this.config.exits.tp1MultR
        : entryTriggerPrice - riskPerUnit * this.config.exits.tp1MultR;

    const tp2Price =
      side === 'LONG'
        ? entryTriggerPrice + riskPerUnit * this.config.exits.tp2MultR
        : entryTriggerPrice - riskPerUnit * this.config.exits.tp2MultR;

    const now = Date.now();

    const plan: TradePlan = {
      id: uuidv4(),
      eventId: event.id,
      symbol: event.symbol,
      side,
      entryTriggerPrice,
      entryType: 'STOP',
      stopPrice,
      tp1Price,
      tp2Price,
      qty: 0,
      notionalUsdc: 0,
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

  // ==================== Logging for Analysis ====================

  private logSetupExpired(
    pending: PendingEvent,
    features: Features,
    elapsed: number,
  ): void {
    const { event } = pending;
    const priceMove = (
      ((features.px - pending.priceAtEvent) / pending.priceAtEvent) *
      100
    ).toFixed(2);

    this.logger.info('⏰ Setup EXPIRED - no stall formed', {
      symbol: event.symbol,
      sideHint: event.sideHint,
      waitedSec: elapsed.toFixed(1),
      priceAtEvent: pending.priceAtEvent.toFixed(2),
      priceNow: features.px.toFixed(2),
      priceMove: priceMove + '%',
      highSinceEvent: pending.highSinceEvent.toFixed(2),
      lowSinceEvent: pending.lowSinceEvent.toFixed(2),
      lastRejectReasons: pending.lastRejectReasons,
      finalStallRange: (features.stallRangePct10s * 100).toFixed(3) + '%',
      finalReplenish: features.bookReplenishScore10s.toFixed(2),
    });

    this.eventBus.emit('setup.expired', {
      eventId: event.id,
      symbol: event.symbol,
      reason: 'timeout_no_stall',
      waitedSec: elapsed,
      lastRejectReasons: pending.lastRejectReasons,
    });
  }

  private logContinuationDetected(
    pending: PendingEvent,
    features: Features,
    reasons: string[],
  ): void {
    const { event } = pending;
    const elapsed = (Date.now() - pending.waitingSince) / 1000;

    this.logger.info('📉 Setup ABORTED - continuation detected', {
      symbol: event.symbol,
      sideHint: event.sideHint,
      waitedSec: elapsed.toFixed(1),
      continuationReasons: reasons,
      priceAtEvent: pending.priceAtEvent.toFixed(2),
      priceNow: features.px.toFixed(2),
      highSinceEvent: pending.highSinceEvent.toFixed(2),
      lowSinceEvent: pending.lowSinceEvent.toFixed(2),
    });

    this.eventBus.emit('setup.aborted', {
      eventId: event.id,
      symbol: event.symbol,
      reason: 'continuation_detected',
      continuationReasons: reasons,
      waitedSec: elapsed,
    });
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
