import { injectable, inject } from 'tsyringe';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { EventBus } from '../../infra/event-bus/event-bus';
import {
  setupEventHandlers,
  EventHandler,
} from '../../infra/event-bus/event-bus.decorators';
import {
  NormalizedTick,
  OrderBookSnap,
} from '../market-data/market-data.types';

export interface DataHealth {
  symbol: string;
  isHealthy: boolean;
  reasons: string[];
  lastTickTs: number;
  lastBookTs: number;
  tickGapMs: number;
  bookGapMs: number;
  wsReconnects: number;
  spreadPct: number;
  topBookDepth: number;
  tradeCount10s: number;
  tickLatencyMs: number;
  bookUpdateId: number;
  bookSeqGap: number;
}

interface SymbolState {
  lastTickTs: number;
  lastBookTs: number;
  lastOiTs: number;
  lastFundingTs: number;
  tickCount10s: number;
  wsReconnectCount: number;
  lastSpreadPct: number;
  lastTopBidDepth: number;
  lastTopAskDepth: number;
  tickTimestamps: number[];
  lastTickLatencyMs: number;
  lastBookUpdateId: number;
  lastBookSeqGap: number;
  lastBookSeqNonMonotonic: boolean;
  depthThinStreak: number;
  depthOkStreak: number;
  depthThinActive: boolean;
}

/**
 * DataIntegrityGuard - prevents trading when data quality is compromised
 *
 * Checks:
 * - WS reconnects too frequent
 * - Tick/book data stale (frozen)
 * - Spread too wide
 * - Book depth too thin
 * - OI/Funding data too old
 * - Trade flow too low (thin market)
 */
@injectable()
export class DataIntegrityGuard {
  private readonly logger: ILogger;
  private symbolStates: Map<string, SymbolState> = new Map();
  private globalHealthy = true;
  private checkIntervalId: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private readonly DEPTH_THIN_CONFIRM_COUNT = 3;
  private readonly DEPTH_THIN_CLEAR_COUNT = 2;

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
  ) {
    this.logger = logger.child('DataIntegrity');
    setupEventHandlers(this);
  }

  async start(): Promise<void> {
    this.logger.info('Starting DataIntegrityGuard...');

    this.startedAt = Date.now();

    for (const symbol of this.config.symbols) {
      this.symbolStates.set(symbol, this.createEmptyState());
    }

    this.checkIntervalId = setInterval(() => {
      this.checkAllSymbols();
    }, 1000);

    this.logger.info('DataIntegrityGuard started', {
      gracePeriodSec: this.config.dataIntegrity.startupGracePeriodMs / 1000,
      maxTickGapMs: this.config.dataIntegrity.maxTickGapMs,
      maxBookGapMs: this.config.dataIntegrity.maxBookGapMs,
      maxTickLatencyMs: this.config.dataIntegrity.maxTickLatencyMs,
      maxFundingAgeMs: this.config.dataIntegrity.maxFundingAgeMs,
      maxBookSeqGap: this.config.dataIntegrity.maxBookSeqGap,
      maxSpreadPct:
        (this.config.dataIntegrity.maxSpreadPct * 100).toFixed(2) + '%',
      minTopDepthUsd: this.config.dataIntegrity.minTopDepthUsd,
    });
  }

  async stop(): Promise<void> {
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
      this.checkIntervalId = null;
    }
    this.logger.info('DataIntegrityGuard stopped');
  }

  private createEmptyState(): SymbolState {
    return {
      lastTickTs: 0,
      lastBookTs: 0,
      lastOiTs: 0,
      lastFundingTs: 0,
      tickCount10s: 0,
      wsReconnectCount: 0,
      lastSpreadPct: 0,
      lastTopBidDepth: 0,
      lastTopAskDepth: 0,
      tickTimestamps: [],
      lastTickLatencyMs: 0,
      lastBookUpdateId: 0,
      lastBookSeqGap: 0,
      lastBookSeqNonMonotonic: false,
      depthThinStreak: 0,
      depthOkStreak: 0,
      depthThinActive: false,
    };
  }

  @EventHandler('tick.normalized')
  onTick(tick: NormalizedTick): void {
    const state = this.symbolStates.get(tick.symbol);
    if (!state) return;

    const now = Date.now();
    state.lastTickTs = now;
    state.lastTickLatencyMs = Math.max(0, now - tick.ts);
    state.tickTimestamps.push(now);

    const cutoff = now - 10000;
    state.tickTimestamps = state.tickTimestamps.filter((ts) => ts > cutoff);
    state.tickCount10s = state.tickTimestamps.length;
  }

  @EventHandler('book.snapshot')
  onBook(book: OrderBookSnap): void {
    const state = this.symbolStates.get(book.symbol);
    if (!state) return;

    state.lastBookTs = Date.now();
    state.lastSpreadPct = book.spreadPct;

    state.lastTopBidDepth = book.bids
      .slice(0, 5)
      .reduce((sum, [px, qty]) => sum + px * qty, 0);
    state.lastTopAskDepth = book.asks
      .slice(0, 5)
      .reduce((sum, [px, qty]) => sum + px * qty, 0);

    if (typeof book.updateId === 'number') {
      if (state.lastBookUpdateId > 0) {
        if (book.updateId <= state.lastBookUpdateId) {
          state.lastBookSeqNonMonotonic = true;
          state.lastBookSeqGap = 0;
        } else {
          state.lastBookSeqNonMonotonic = false;
          state.lastBookSeqGap = book.updateId - state.lastBookUpdateId - 1;
        }
      }
      state.lastBookUpdateId = book.updateId;
    }
  }

  @EventHandler('ws.reconnect')
  onWsReconnectEvent(data: {
    scope: 'all' | 'symbol';
    symbol?: string;
    stage: 'reconnecting' | 'reconnected';
  }): void {
    if (data.stage !== 'reconnecting') return;
    if (data.scope === 'all') {
      for (const symbol of this.config.symbols) {
        this.onWsReconnect(symbol);
      }
      return;
    }
    if (data.symbol) {
      this.onWsReconnect(data.symbol);
    }
  }

  private onWsReconnect(symbol: string): void {
    const state = this.symbolStates.get(symbol);
    if (!state) return;

    state.wsReconnectCount++;
    this.logger.warn('WS reconnect detected', {
      symbol,
      count: state.wsReconnectCount,
    });

    setTimeout(
      () => {
        const s = this.symbolStates.get(symbol);
        if (s && s.wsReconnectCount > 0) {
          s.wsReconnectCount--;
        }
      },
      5 * 60 * 1000,
    );
  }

  @EventHandler('market.oi.updated')
  onOiUpdated(data: { symbol: string; ts: number }): void {
    this.recordOiUpdate(data.symbol, data.ts);
  }

  private recordOiUpdate(symbol: string, ts?: number): void {
    const state = this.symbolStates.get(symbol);
    if (state) {
      state.lastOiTs = ts || Date.now();
    }
  }

  @EventHandler('market.funding.updated')
  onFundingUpdated(data: { symbol: string; ts: number }): void {
    this.recordFundingUpdate(data.symbol, data.ts);
  }

  private recordFundingUpdate(symbol: string, ts?: number): void {
    const state = this.symbolStates.get(symbol);
    if (state) {
      state.lastFundingTs = ts || Date.now();
    }
  }

  private checkAllSymbols(): void {
    const now = Date.now();
    let allHealthy = true;

    for (const symbol of this.config.symbols) {
      const health = this.checkSymbolHealth(symbol, now);

      if (!health.isHealthy && this.globalHealthy) {
        this.logger.warn('🚨 Data integrity compromised', {
          symbol,
          reasons: health.reasons,
        });

        this.eventBus.emit('data-integrity.unhealthy', {
          symbol,
          reasons: health.reasons,
          timestamp: now,
        });
      }

      if (!health.isHealthy) {
        allHealthy = false;
      }
    }

    if (this.globalHealthy && !allHealthy) {
      this.globalHealthy = false;
      this.eventBus.emit('risk.trading-halted', {
        reason: 'data_integrity_failed',
        timestamp: now,
      });
    } else if (!this.globalHealthy && allHealthy) {
      this.globalHealthy = true;
      this.logger.info('✅ Data integrity restored');
      this.eventBus.emit('data-integrity.restored', { timestamp: now });
    }
  }

  private checkSymbolHealth(symbol: string, now: number): DataHealth {
    const state = this.symbolStates.get(symbol);
    const reasons: string[] = [];
    const cfg = this.config.dataIntegrity;

    // During startup grace period, don't flag missing data as unhealthy
    const inGracePeriod = now - this.startedAt < cfg.startupGracePeriodMs;

    if (!state) {
      return {
        symbol,
        isHealthy: inGracePeriod,
        reasons: inGracePeriod ? [] : ['no_state'],
        lastTickTs: 0,
        lastBookTs: 0,
        tickGapMs: 0,
        bookGapMs: 0,
        wsReconnects: 0,
        spreadPct: 0,
        topBookDepth: 0,
        tradeCount10s: 0,
        tickLatencyMs: 0,
        bookUpdateId: 0,
        bookSeqGap: 0,
      };
    }

    // Calculate gaps only if we've received data before
    const tickGapMs = state.lastTickTs > 0 ? now - state.lastTickTs : 0;
    const bookGapMs = state.lastBookTs > 0 ? now - state.lastBookTs : 0;

    // Check tick freshness
    if (state.lastTickTs > 0 && tickGapMs > cfg.maxTickGapMs) {
      reasons.push(`tick_stale_${Math.round(tickGapMs / 1000)}s`);
    } else if (state.lastTickTs === 0 && !inGracePeriod) {
      reasons.push('no_ticks_received');
    }

    // Check book freshness
    if (state.lastBookTs > 0 && bookGapMs > cfg.maxBookGapMs) {
      reasons.push(`book_stale_${Math.round(bookGapMs / 1000)}s`);
    } else if (state.lastBookTs === 0 && !inGracePeriod) {
      reasons.push('no_book_received');
    }

    // Check spread
    if (state.lastBookTs > 0 && state.lastSpreadPct > cfg.maxSpreadPct) {
      reasons.push(`spread_wide_${(state.lastSpreadPct * 100).toFixed(2)}%`);
    }

    // Check book depth with hysteresis to avoid flapping
    const minDepth = Math.min(state.lastTopBidDepth, state.lastTopAskDepth);
    if (state.lastBookTs > 0) {
      const isThin = minDepth < cfg.minTopDepthUsd;

      if (isThin) {
        state.depthThinStreak += 1;
        state.depthOkStreak = 0;
        if (state.depthThinStreak >= this.DEPTH_THIN_CONFIRM_COUNT) {
          state.depthThinActive = true;
        }
      } else {
        state.depthOkStreak += 1;
        state.depthThinStreak = 0;
        if (state.depthOkStreak >= this.DEPTH_THIN_CLEAR_COUNT) {
          state.depthThinActive = false;
        }
      }

      if (state.depthThinActive) {
        reasons.push(`depth_thin_${Math.round(minDepth)}`);
      }
    }

    // Check trade flow (only after grace period)
    if (
      !inGracePeriod &&
      state.lastTickTs > 0 &&
      state.tickCount10s < cfg.minTrades10s
    ) {
      reasons.push(`low_flow_${state.tickCount10s}_trades`);
    }

    // Check tick latency
    if (
      !inGracePeriod &&
      state.lastTickTs > 0 &&
      state.lastTickLatencyMs > cfg.maxTickLatencyMs
    ) {
      reasons.push(`tick_latency_${state.lastTickLatencyMs}ms`);
    }

    // Check WS reconnects
    if (state.wsReconnectCount >= cfg.maxReconnects5min) {
      reasons.push(`ws_unstable_${state.wsReconnectCount}_reconnects`);
    }

    // Check OI freshness
    if (state.lastOiTs > 0 && now - state.lastOiTs > cfg.maxOiAgeMs) {
      reasons.push(`oi_stale_${Math.round((now - state.lastOiTs) / 60000)}min`);
    }

    // Check funding freshness
    if (
      state.lastFundingTs > 0 &&
      now - state.lastFundingTs > cfg.maxFundingAgeMs
    ) {
      reasons.push(
        `funding_stale_${Math.round((now - state.lastFundingTs) / 60000)}min`,
      );
    }

    // Check orderbook sequence gaps (if updateId available)
    if (state.lastBookSeqNonMonotonic) {
      reasons.push('book_seq_non_monotonic');
    } else if (state.lastBookSeqGap > cfg.maxBookSeqGap) {
      reasons.push(`book_seq_gap_${state.lastBookSeqGap}`);
    }

    return {
      symbol,
      isHealthy: reasons.length === 0,
      reasons,
      lastTickTs: state.lastTickTs,
      lastBookTs: state.lastBookTs,
      tickGapMs,
      bookGapMs,
      wsReconnects: state.wsReconnectCount,
      spreadPct: state.lastSpreadPct,
      topBookDepth: minDepth,
      tradeCount10s: state.tickCount10s,
      tickLatencyMs: state.lastTickLatencyMs,
      bookUpdateId: state.lastBookUpdateId,
      bookSeqGap: state.lastBookSeqGap,
    };
  }

  canTrade(symbol: string): { allowed: boolean; reason?: string } {
    if (!this.globalHealthy) {
      return { allowed: false, reason: 'global_data_integrity_failed' };
    }

    const health = this.checkSymbolHealth(symbol, Date.now());
    if (!health.isHealthy) {
      return { allowed: false, reason: health.reasons.join(',') };
    }

    return { allowed: true };
  }

  isHealthy(): boolean {
    return this.globalHealthy;
  }

  getHealth(symbol: string): DataHealth {
    return this.checkSymbolHealth(symbol, Date.now());
  }

  getAllHealth(): DataHealth[] {
    return this.config.symbols.map((s) =>
      this.checkSymbolHealth(s, Date.now()),
    );
  }
}
