import { injectable, inject } from 'tsyringe';
import dayjs from 'dayjs';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { EventBus } from '../../infra/event-bus/event-bus';
import { BinanceClient } from '../../integrations/exchanges/binance/binance';
import { TradePlan } from '../setup-engine/setup-engine.types';
import {
  setupEventHandlers,
  EventHandler,
} from '../../infra/event-bus/event-bus.decorators';

interface DailyStats {
  date: string;
  pnlUsdc: number;
  tradesCount: number;
  wins: number;
  losses: number;
  tradingHalted: boolean;
}

@injectable()
export class RiskManager {
  private readonly logger: ILogger;

  // Track daily P&L
  private dailyStats: DailyStats;

  // Track equity
  private lastKnownEquity: number = 0;

  // Trading halted flag
  private tradingHalted: boolean = false;

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
    @inject(TOKENS.BINANCE_CLIENT) private binance: BinanceClient,
  ) {
    this.logger = logger.child('RiskManager');
    this.dailyStats = this.createEmptyDailyStats();
    setupEventHandlers(this);
  }

  async start(): Promise<void> {
    this.logger.info('Starting RiskManager...');

    // Load initial equity (skip if simulation mode or no API keys)
    if (this.config.isSimulation()) {
      this.logger.warn('🎮 SIMULATION MODE - using virtual equity');
      this.lastKnownEquity = 10000; // $10k virtual equity
    } else if (this.config.hasApiKeys()) {
      await this.updateEquity();
    } else {
      this.logger.warn('No API keys - running in OBSERVE ONLY mode');
      this.lastKnownEquity = 10000;
    }

    // Schedule daily reset at midnight UTC
    this.scheduleDailyReset();

    this.logger.info('RiskManager started', {
      mode: this.config.isSimulation()
        ? 'SIMULATION'
        : this.config.hasApiKeys()
          ? 'LIVE'
          : 'OBSERVE',
      equity: this.lastKnownEquity.toFixed(2),
      maxRiskPerTrade:
        (this.config.risk.maxRiskPerTrade * 100).toFixed(2) + '%',
      dailyLossLimit: (this.config.risk.dailyLossLimit * 100).toFixed(2) + '%',
    });
  }

  private createEmptyDailyStats(): DailyStats {
    return {
      date: dayjs().format('YYYY-MM-DD'),
      pnlUsdc: 0,
      tradesCount: 0,
      wins: 0,
      losses: 0,
      tradingHalted: false,
    };
  }

  private scheduleDailyReset(): void {
    // Check every minute if we crossed midnight
    setInterval(() => {
      const today = dayjs().format('YYYY-MM-DD');
      if (today !== this.dailyStats.date) {
        this.logger.info('New day - resetting daily stats', {
          previousDate: this.dailyStats.date,
          previousPnl: this.dailyStats.pnlUsdc.toFixed(2),
        });

        this.dailyStats = this.createEmptyDailyStats();
        this.tradingHalted = false;

        this.eventBus.emit('risk.trading-resumed', {
          timestamp: Date.now(),
        });
      }
    }, 60 * 1000);
  }

  async updateEquity(): Promise<number> {
    // Skip if simulation mode or no API keys
    if (this.config.isSimulation() || !this.config.hasApiKeys()) {
      return this.lastKnownEquity;
    }

    try {
      const balance = await this.binance.getBalance('USDT');
      this.lastKnownEquity = balance.total;
      return this.lastKnownEquity;
    } catch (error) {
      this.logger.error('Failed to update equity', error as Error);
      return this.lastKnownEquity;
    }
  }

  // ==================== Event Handlers ====================

  @EventHandler('position.closed')
  onPositionClosed(data: {
    planId: string;
    pnlUsdc: number;
    reason: string;
  }): void {
    this.dailyStats.pnlUsdc += data.pnlUsdc;
    this.dailyStats.tradesCount++;

    if (data.pnlUsdc >= 0) {
      this.dailyStats.wins++;
    } else {
      this.dailyStats.losses++;
    }

    this.logger.info('Trade recorded', {
      pnlUsdc: data.pnlUsdc.toFixed(2),
      dailyPnl: this.dailyStats.pnlUsdc.toFixed(2),
      wins: this.dailyStats.wins,
      losses: this.dailyStats.losses,
    });

    // Check daily loss limit
    this.checkDailyLossLimit();
  }

  private checkDailyLossLimit(): void {
    if (this.tradingHalted) return;

    const lossLimit = this.lastKnownEquity * this.config.risk.dailyLossLimit;

    if (this.dailyStats.pnlUsdc < -lossLimit) {
      this.tradingHalted = true;
      this.dailyStats.tradingHalted = true;

      this.logger.warn('🛑 DAILY LOSS LIMIT HIT - Trading halted', {
        dailyPnl: this.dailyStats.pnlUsdc.toFixed(2),
        limit: (-lossLimit).toFixed(2),
      });

      this.eventBus.emit('risk.daily-limit-hit', {
        date: this.dailyStats.date,
        lossUsdc: Math.abs(this.dailyStats.pnlUsdc),
        limit: lossLimit,
      });

      this.eventBus.emit('risk.trading-halted', {
        reason: 'daily_loss_limit',
        timestamp: Date.now(),
      });
    }
  }

  // ==================== Position Sizing ====================

  calculatePositionSize(plan: TradePlan): {
    qty: number;
    notionalUsdc: number;
    riskUsdc: number;
    riskPercent: number;
  } {
    const equity = this.lastKnownEquity;

    if (equity === 0) {
      this.logger.warn('Equity is 0, cannot size position');
      return { qty: 0, notionalUsdc: 0, riskUsdc: 0, riskPercent: 0 };
    }

    // Calculate risk in USD
    const riskPercent = this.config.risk.maxRiskPerTrade;
    const riskUsdc = equity * riskPercent;

    // Calculate distance to stop (as percentage)
    const stopDistance =
      Math.abs(plan.entryTriggerPrice - plan.stopPrice) /
      plan.entryTriggerPrice;

    if (stopDistance === 0) {
      this.logger.warn('Stop distance is 0, cannot size position');
      return { qty: 0, notionalUsdc: 0, riskUsdc: 0, riskPercent: 0 };
    }

    // Calculate notional size: risk / stopDistance
    let notionalUsdc = riskUsdc / stopDistance;

    // Apply maximum notional cap
    if (notionalUsdc > this.config.risk.maxNotionalPerTrade) {
      notionalUsdc = this.config.risk.maxNotionalPerTrade;
    }

    // Calculate quantity
    const qty = notionalUsdc / plan.entryTriggerPrice;

    // Recalculate actual risk based on capped notional
    const actualRiskUsdc = notionalUsdc * stopDistance;
    const actualRiskPercent = actualRiskUsdc / equity;

    this.logger.debug('Position sized', {
      symbol: plan.symbol,
      equity: equity.toFixed(2),
      riskPercent: (actualRiskPercent * 100).toFixed(2) + '%',
      riskUsdc: actualRiskUsdc.toFixed(2),
      notionalUsdc: notionalUsdc.toFixed(2),
      qty: qty.toFixed(4),
      stopDistance: (stopDistance * 100).toFixed(2) + '%',
    });

    return {
      qty,
      notionalUsdc,
      riskUsdc: actualRiskUsdc,
      riskPercent: actualRiskPercent,
    };
  }

  sizePlan(plan: TradePlan): TradePlan {
    const sizing = this.calculatePositionSize(plan);

    plan.qty = sizing.qty;
    plan.notionalUsdc = sizing.notionalUsdc;
    plan.riskUsdc = sizing.riskUsdc;
    plan.riskPercent = sizing.riskPercent;

    return plan;
  }

  // ==================== Risk Checks ====================

  canOpenPosition(): { allowed: boolean; reason?: string } {
    if (this.tradingHalted) {
      return { allowed: false, reason: 'daily_loss_limit_hit' };
    }

    if (this.lastKnownEquity === 0) {
      return { allowed: false, reason: 'no_equity' };
    }

    return { allowed: true };
  }

  isTradingAllowed(): boolean {
    return !this.tradingHalted;
  }

  // ==================== Getters ====================

  getEquity(): number {
    return this.lastKnownEquity;
  }

  getDailyStats(): DailyStats {
    return { ...this.dailyStats };
  }

  getDailyPnl(): number {
    return this.dailyStats.pnlUsdc;
  }

  getDailyPnlPercent(): number {
    if (this.lastKnownEquity === 0) return 0;
    return this.dailyStats.pnlUsdc / this.lastKnownEquity;
  }

  isTradingHalted(): boolean {
    return this.tradingHalted;
  }

  // Manual override to resume trading (use with caution)
  manualResumeTrading(): void {
    if (!this.tradingHalted) return;

    this.tradingHalted = false;
    this.logger.warn('Trading manually resumed');

    this.eventBus.emit('risk.trading-resumed', {
      timestamp: Date.now(),
    });
  }
}
