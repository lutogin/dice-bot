import { injectable, inject } from 'tsyringe';
import dayjs from 'dayjs';
import { v4 as uuidv4 } from 'uuid';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { EventBus } from '../../infra/event-bus/event-bus';
import {
  TradeRecord,
  DailyMetrics,
  DetectionMetrics,
  TradeResult,
} from './journal.types';
import { ForcedEvent } from '../detectors/detector.types';
import { TradePlan } from '../setup-engine/setup-engine.types';
import {
  setupEventHandlers,
  EventHandler,
} from '../../infra/event-bus/event-bus.decorators';
import { ForcedEventsRepository } from '../../integrations/database/repositories/forced-events.repository';
import { TradePlansRepository } from '../../integrations/database/repositories/trade-plans.repository';
import { TradesRepository } from '../../integrations/database/repositories/trades.repository';

@injectable()
export class JournalService {
  private readonly logger: ILogger;

  // In-memory cache (backed by PostgreSQL)
  private trades: TradeRecord[] = [];
  private events: ForcedEvent[] = [];
  private plans: TradePlan[] = [];

  // Metrics counters
  private detectionMetrics: DetectionMetrics = {
    totalEvents: 0,
    passedClassification: 0,
    setupsCreated: 0,
    entriesTriggered: 0,
    filterRate: 0,
  };

  // Latency tracking
  private latencyMetrics: {
    eventToClassify: number[];
    classifyToSetup: number[];
    setupToArm: number[];
    armToTrigger: number[];
    triggerToFill: number[];
  } = {
    eventToClassify: [],
    classifyToSetup: [],
    setupToArm: [],
    armToTrigger: [],
    triggerToFill: [],
  };

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
    @inject(TOKENS.FORCED_EVENTS_REPO)
    private eventsRepo: ForcedEventsRepository,
    @inject(TOKENS.TRADE_PLANS_REPO) private plansRepo: TradePlansRepository,
    @inject(TOKENS.TRADES_REPO) private tradesRepo: TradesRepository,
  ) {
    this.logger = logger.child('Journal');
    setupEventHandlers(this);
  }

  async start(): Promise<void> {
    this.logger.info('Starting JournalService...');

    // Load recent data from PostgreSQL into cache
    try {
      this.events = await this.eventsRepo.findRecent(100);
      this.plans = await this.plansRepo.findRecent(100);
      this.trades = await this.tradesRepo.findRecent(100);

      this.logger.info('Loaded journal data from PostgreSQL', {
        events: this.events.length,
        plans: this.plans.length,
        trades: this.trades.length,
      });
    } catch (error) {
      this.logger.warn(
        'Could not load journal data from PostgreSQL, starting fresh',
        {
          error: (error as Error).message,
        },
      );
    }

    this.logger.info('JournalService started');
  }

  // ==================== Event Handlers ====================

  @EventHandler('forced-event.detected')
  async onForcedEvent(event: ForcedEvent): Promise<void> {
    this.events.push(event);
    this.detectionMetrics.totalEvents++;

    // Persist to PostgreSQL
    try {
      await this.eventsRepo.save(event);
    } catch (error) {
      this.logger.error('Failed to persist forced event', error as Error);
    }

    this.logger.debug('Event logged', {
      eventId: event.id,
      type: event.type,
      symbol: event.symbol,
    });
  }

  @EventHandler('signal.classified')
  onSignalClassified(data: {
    event: ForcedEvent;
    passed: boolean;
    reason?: string;
  }): void {
    if (data.passed) {
      this.detectionMetrics.passedClassification++;
    }

    this.updateFilterRate();
  }

  @EventHandler('trade-plan.created')
  async onPlanCreated(plan: TradePlan): Promise<void> {
    this.plans.push(plan);
    this.detectionMetrics.setupsCreated++;

    // Track latency from event to setup
    const event = this.events.find((e) => e.id === plan.eventId);
    if (event) {
      const latency = plan.createdAt - event.ts;
      this.latencyMetrics.classifyToSetup.push(latency);
      // Keep only last 100 samples
      if (this.latencyMetrics.classifyToSetup.length > 100) {
        this.latencyMetrics.classifyToSetup.shift();
      }
    }

    // Persist to PostgreSQL
    try {
      await this.plansRepo.save(plan);
    } catch (error) {
      this.logger.error('Failed to persist trade plan', error as Error);
    }
  }

  @EventHandler('trade-plan.triggered')
  async onPlanTriggered(plan: TradePlan): Promise<void> {
    this.detectionMetrics.entriesTriggered++;

    // Track latency from arm to trigger
    if (plan.armedAt && plan.triggeredAt) {
      const latency = plan.triggeredAt - plan.armedAt;
      this.latencyMetrics.armToTrigger.push(latency);
      if (this.latencyMetrics.armToTrigger.length > 100) {
        this.latencyMetrics.armToTrigger.shift();
      }
    }

    // Update status in PostgreSQL
    try {
      await this.plansRepo.updateStatus(plan.id, 'TRIGGERED', {
        triggeredAt: plan.triggeredAt,
      });
    } catch (error) {
      this.logger.error('Failed to update plan status', error as Error);
    }
  }

  @EventHandler('trade-plan.armed')
  async onPlanArmed(plan: TradePlan): Promise<void> {
    // Track latency from setup to arm
    if (plan.armedAt) {
      const latency = plan.armedAt - plan.createdAt;
      this.latencyMetrics.setupToArm.push(latency);
      if (this.latencyMetrics.setupToArm.length > 100) {
        this.latencyMetrics.setupToArm.shift();
      }
    }

    try {
      await this.plansRepo.updateStatus(plan.id, 'ARMED', {
        armedAt: plan.armedAt,
      });
    } catch (error) {
      this.logger.error('Failed to update plan status', error as Error);
    }
  }

  @EventHandler('trade-plan.filled')
  async onPlanFilled(plan: TradePlan): Promise<void> {
    // Track latency from trigger to fill
    if (plan.triggeredAt && plan.filledAt) {
      const latency = plan.filledAt - plan.triggeredAt;
      this.latencyMetrics.triggerToFill.push(latency);
      if (this.latencyMetrics.triggerToFill.length > 100) {
        this.latencyMetrics.triggerToFill.shift();
      }
    }

    try {
      await this.plansRepo.updateStatus(plan.id, 'FILLED', {
        filledAt: plan.filledAt,
      });
    } catch (error) {
      this.logger.error('Failed to update plan status', error as Error);
    }
  }

  @EventHandler('position.closed')
  async onPositionClosed(data: {
    planId: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    entryPrice: number;
    exitPrice: number;
    qty: number;
    pnlUsdc: number;
    pnlR: number;
    reason: 'TP' | 'SL' | 'MANUAL' | 'KILL_SWITCH';
    feesUsdc: number;
    slippageUsdc: number;
    mfe: number;
    mae: number;
    holdTimeMs: number;
  }): Promise<void> {
    const plan = this.plans.find((p) => p.id === data.planId);
    const event = plan ? this.events.find((e) => e.id === plan.eventId) : null;

    // Determine result
    let result: TradeResult = 'BREAKEVEN';
    if (data.pnlR >= 0.1) result = 'WIN';
    else if (data.pnlR <= -0.1) result = 'LOSS';

    const now = Date.now();

    const trade: TradeRecord = {
      id: uuidv4(),
      planId: data.planId,
      eventId: plan?.eventId || '',
      symbol: data.symbol,
      side: data.side,
      entryPrice: data.entryPrice,
      exitPrice: data.exitPrice,
      stopPrice: plan?.stopPrice || 0,
      tpPrice: plan?.tp1Price || 0,
      qty: data.qty,
      notionalUsdc: plan?.notionalUsdc || data.entryPrice * data.qty,
      pnlUsdc: data.pnlUsdc,
      pnlR: data.pnlR,
      feesUsdc: data.feesUsdc,
      slippageUsdc: data.slippageUsdc,
      mfe: data.mfe,
      mae: data.mae,
      holdTimeMs: data.holdTimeMs,
      createdAt: plan?.createdAt || now,
      filledAt: plan?.filledAt || now,
      closedAt: now,
      exitReason: data.reason,
      result,
    };

    this.trades.push(trade);

    // Persist to PostgreSQL
    try {
      await this.tradesRepo.save(trade);
    } catch (error) {
      this.logger.error('Failed to persist trade', error as Error);
    }

    this.logger.info('Trade recorded', {
      tradeId: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      pnlUsdc: trade.pnlUsdc.toFixed(2),
      pnlR: trade.pnlR.toFixed(2),
      result: trade.result,
      mfe: (trade.mfe * 100).toFixed(2) + '%',
      mae: (trade.mae * 100).toFixed(2) + '%',
      fees: trade.feesUsdc.toFixed(4),
      slippage: trade.slippageUsdc.toFixed(4),
      holdTimeMs: trade.holdTimeMs,
    });
  }

  // ==================== Metrics Calculation ====================

  private updateFilterRate(): void {
    if (this.detectionMetrics.totalEvents > 0) {
      this.detectionMetrics.filterRate =
        1 -
        this.detectionMetrics.passedClassification /
          this.detectionMetrics.totalEvents;
    }
  }

  getDailyMetrics(date?: string): DailyMetrics {
    const targetDate = date || dayjs().format('YYYY-MM-DD');

    const dayTrades = this.trades.filter(
      (t) => dayjs(t.closedAt).format('YYYY-MM-DD') === targetDate,
    );

    const wins = dayTrades.filter((t) => t.result === 'WIN').length;
    const losses = dayTrades.filter((t) => t.result === 'LOSS').length;
    const tradesCount = dayTrades.length;

    const pnlUsdc = dayTrades.reduce((sum, t) => sum + t.pnlUsdc, 0);
    const pnlR = dayTrades.reduce((sum, t) => sum + t.pnlR, 0);
    const avgR = tradesCount > 0 ? pnlR / tradesCount : 0;
    const winRate = tradesCount > 0 ? wins / tradesCount : 0;

    // Calculate max drawdown (simplified)
    let running = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const trade of dayTrades) {
      running += trade.pnlUsdc;
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    return {
      date: targetDate,
      tradesCount,
      wins,
      losses,
      winRate,
      pnlUsdc,
      pnlR,
      avgR,
      maxDrawdown,
    };
  }

  getDetectionMetrics(): DetectionMetrics {
    return { ...this.detectionMetrics };
  }

  getOverallStats(): {
    totalTrades: number;
    totalPnlUsdc: number;
    winRate: number;
    avgR: number;
    profitFactor: number;
  } {
    const totalTrades = this.trades.length;
    const wins = this.trades.filter((t) => t.result === 'WIN');
    const losses = this.trades.filter((t) => t.result === 'LOSS');

    const totalPnlUsdc = this.trades.reduce((sum, t) => sum + t.pnlUsdc, 0);
    const totalR = this.trades.reduce((sum, t) => sum + t.pnlR, 0);

    const winRate = totalTrades > 0 ? wins.length / totalTrades : 0;
    const avgR = totalTrades > 0 ? totalR / totalTrades : 0;

    const grossProfit = wins.reduce((sum, t) => sum + t.pnlUsdc, 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnlUsdc, 0));
    const profitFactor =
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    return {
      totalTrades,
      totalPnlUsdc,
      winRate,
      avgR,
      profitFactor,
    };
  }

  // ==================== Trade History ====================

  getRecentTrades(limit: number = 10): TradeRecord[] {
    return this.trades.slice(-limit).reverse();
  }

  getTradesBySymbol(symbol: string): TradeRecord[] {
    return this.trades.filter((t) => t.symbol === symbol);
  }

  getTradesByDate(date: string): TradeRecord[] {
    return this.trades.filter(
      (t) => dayjs(t.closedAt).format('YYYY-MM-DD') === date,
    );
  }

  // ==================== Event History ====================

  getRecentEvents(limit: number = 20): ForcedEvent[] {
    return this.events.slice(-limit).reverse();
  }

  // ==================== Export ====================

  exportTrades(): TradeRecord[] {
    return [...this.trades];
  }

  exportMetrics(): {
    daily: DailyMetrics;
    detection: DetectionMetrics;
    overall: ReturnType<JournalService['getOverallStats']>;
  } {
    return {
      daily: this.getDailyMetrics(),
      detection: this.getDetectionMetrics(),
      overall: this.getOverallStats(),
    };
  }

  // ==================== Latency Metrics ====================

  getLatencyMetrics(): {
    eventToClassifyAvgMs: number;
    classifyToSetupAvgMs: number;
    setupToArmAvgMs: number;
    armToTriggerAvgMs: number;
    triggerToFillAvgMs: number;
  } {
    const avg = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    return {
      eventToClassifyAvgMs: avg(this.latencyMetrics.eventToClassify),
      classifyToSetupAvgMs: avg(this.latencyMetrics.classifyToSetup),
      setupToArmAvgMs: avg(this.latencyMetrics.setupToArm),
      armToTriggerAvgMs: avg(this.latencyMetrics.armToTrigger),
      triggerToFillAvgMs: avg(this.latencyMetrics.triggerToFill),
    };
  }
}
