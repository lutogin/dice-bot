import { injectable, inject } from 'tsyringe';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { EventBus } from '../../infra/event-bus/event-bus';
import { MarketDataService } from '../market-data/market-data.service';
import {
  setupEventHandlers,
  EventHandler,
} from '../../infra/event-bus/event-bus.decorators';
import {
  NormalizedTick,
  OrderBookSnap,
  LiqPrint,
} from '../market-data/market-data.types';
import { Features, RollingWindow, FeatureBaselines } from './features.types';
import { MathUtils } from '../../infra/utils';

const WINDOW_SIZES = {
  TRADES_30S: 30 * 1000,
  TRADES_1M: 60 * 1000,
  LIQS_30S: 30 * 1000,
  LIQS_1M: 60 * 1000,
  LIQS_1H: 60 * 60 * 1000,
  BOOK_10S: 10 * 1000,
  PRICES_5S: 5 * 1000,
  PRICES_30S: 30 * 1000,
};

@injectable()
export class FeatureBuilder {
  private readonly logger: ILogger;
  private windows: Map<string, RollingWindow> = new Map();
  private baselines: Map<string, FeatureBaselines> = new Map();
  private lastFeatures: Map<string, Features> = new Map();
  private lastEmitTime: Map<string, number> = new Map();

  // Volatility history for 24h percentile calculation
  private rvHistory: Map<string, { ts: number; rv: number }[]> = new Map();
  private readonly RV_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Emit features at most every N ms per symbol
  private readonly EMIT_THROTTLE_MS = 100;

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
    @inject(TOKENS.MARKET_DATA_SERVICE) private marketData: MarketDataService,
  ) {
    this.logger = logger.child('FeatureBuilder');
    setupEventHandlers(this);
  }

  async start(): Promise<void> {
    this.logger.info('Starting FeatureBuilder...');

    // Initialize windows for each symbol
    for (const symbol of this.config.symbols) {
      this.windows.set(symbol, this.createEmptyWindow(symbol));
      this.baselines.set(symbol, this.createEmptyBaselines(symbol));
      this.rvHistory.set(symbol, []);
    }

    // Start baseline recalculation (every 5 minutes)
    setInterval(() => this.recalculateBaselines(), 5 * 60 * 1000);

    this.logger.info('FeatureBuilder started');
  }

  private createEmptyWindow(symbol: string): RollingWindow {
    return {
      symbol,
      prices1s: [],
      prices5s: [],
      trades30s: [],
      trades1m: [],
      liqs30s: [],
      liqs1m: [],
      liqs1h: [],
      bookSnapshots10s: [],
      priceRange10s: { high: 0, low: Infinity, mid: 0 },
    };
  }

  private createEmptyBaselines(symbol: string): FeatureBaselines {
    return {
      symbol,
      medianLiqNotional30s1h: 0,
      p90LiqNotional30s1h: 0,
      medianRv30s24h: 0,
      p90Rv30s24h: 0,
      updatedAt: 0,
    };
  }

  // ==================== Event Handlers ====================

  @EventHandler('tick.normalized')
  handleTick(tick: NormalizedTick): void {
    const window = this.windows.get(tick.symbol);
    if (!window) return;

    const now = tick.ts;

    // Add to price arrays
    window.prices1s.push({ ts: now, price: tick.price });
    window.prices5s.push({ ts: now, price: tick.price });

    // Add to trade arrays
    const trade = {
      ts: now,
      price: tick.price,
      qty: tick.qty,
      side: tick.side,
      notional: tick.notionalUsdc,
    };
    window.trades30s.push(trade);
    window.trades1m.push(trade);

    // Update price range for stall detection
    this.updatePriceRange10s(window, tick.price, now);

    // Prune old data
    this.pruneWindow(window, now);

    // Recalculate and emit features
    this.maybeEmitFeatures(tick.symbol, now);
  }

  @EventHandler('book.snapshot')
  handleBook(book: OrderBookSnap): void {
    const window = this.windows.get(book.symbol);
    if (!window) return;

    const now = book.ts;

    // Add book snapshot for replenish calculation
    const topBidQty = book.bids
      .slice(0, 5)
      .reduce((sum, [, qty]) => sum + qty, 0);
    const topAskQty = book.asks
      .slice(0, 5)
      .reduce((sum, [, qty]) => sum + qty, 0);

    window.bookSnapshots10s.push({
      ts: now,
      topBidQty,
      topAskQty,
    });

    // Prune old book snapshots
    const cutoff10s = now - WINDOW_SIZES.BOOK_10S;
    window.bookSnapshots10s = window.bookSnapshots10s.filter(
      (s) => s.ts > cutoff10s,
    );
  }

  @EventHandler('liq.print')
  handleLiq(liq: LiqPrint): void {
    const window = this.windows.get(liq.symbol);
    if (!window) return;

    const now = liq.ts;
    const liqData = { ts: now, notional: liq.notionalUsdc, side: liq.side };

    window.liqs30s.push(liqData);
    window.liqs1m.push(liqData);
    window.liqs1h.push(liqData);

    // Prune
    this.pruneWindow(window, now);

    // Force recalc on liquidation
    this.maybeEmitFeatures(liq.symbol, now, true);
  }

  // ==================== Window Management ====================

  private pruneWindow(window: RollingWindow, now: number): void {
    const cutoff1s = now - 1000;
    const cutoff5s = now - WINDOW_SIZES.PRICES_5S;
    const cutoff30s = now - WINDOW_SIZES.TRADES_30S;
    const cutoff1m = now - WINDOW_SIZES.TRADES_1M;
    const cutoff1h = now - WINDOW_SIZES.LIQS_1H;

    window.prices1s = window.prices1s.filter((p) => p.ts > cutoff1s);
    window.prices5s = window.prices5s.filter((p) => p.ts > cutoff5s);
    window.trades30s = window.trades30s.filter((t) => t.ts > cutoff30s);
    window.trades1m = window.trades1m.filter((t) => t.ts > cutoff1m);
    window.liqs30s = window.liqs30s.filter((l) => l.ts > cutoff30s);
    window.liqs1m = window.liqs1m.filter((l) => l.ts > cutoff1m);
    window.liqs1h = window.liqs1h.filter((l) => l.ts > cutoff1h);
  }

  private updatePriceRange10s(
    window: RollingWindow,
    price: number,
    now: number,
  ): void {
    // Simple approach: just track high/low from prices in last 10s
    const cutoff = now - 10 * 1000;
    const recentPrices = window.prices5s
      .filter((p) => p.ts > cutoff)
      .map((p) => p.price);

    recentPrices.push(price);

    if (recentPrices.length > 0) {
      window.priceRange10s = {
        high: Math.max(...recentPrices),
        low: Math.min(...recentPrices),
        mid: price,
      };
    }
  }

  // ==================== Feature Calculation ====================

  private maybeEmitFeatures(
    symbol: string,
    now: number,
    force: boolean = false,
  ): void {
    const lastEmit = this.lastEmitTime.get(symbol) || 0;
    if (!force && now - lastEmit < this.EMIT_THROTTLE_MS) {
      return;
    }

    const features = this.calculateFeatures(symbol, now);
    if (!features) return;

    this.lastFeatures.set(symbol, features);
    this.lastEmitTime.set(symbol, now);

    this.eventBus.emit('features.updated', { symbol, features });
  }

  private calculateFeatures(symbol: string, now: number): Features | null {
    const window = this.windows.get(symbol);
    if (!window) return null;

    const state = this.marketData.getState(symbol);
    if (!state) return null;

    const book = state.lastBook;
    const currentPrice = state.lastPrice;
    if (currentPrice === 0) return null;

    // Calculate returns
    const ret5s = this.calcReturn(window.prices5s, currentPrice, 5000);
    const ret30s = this.calcReturn(window.prices5s, currentPrice, 30000);
    const ret1m = this.calcReturn(
      window.trades1m.map((t) => ({ ts: t.ts, price: t.price })),
      currentPrice,
      60000,
    );

    // Calculate volatility (std dev of log returns)
    const rv30s = this.calcRealizedVol(window.trades30s.map((t) => t.price));
    const rv1m = this.calcRealizedVol(window.trades1m.map((t) => t.price));

    // Record volatility sample for 24h percentile calculation
    this.recordVolatilitySample(symbol, rv30s, now);

    // Liquidation metrics
    const liqNotional30s = window.liqs30s.reduce(
      (sum, l) => sum + l.notional,
      0,
    );
    const liqCount30s = window.liqs30s.length;
    const liqNotional1m = window.liqs1m.reduce((sum, l) => sum + l.notional, 0);

    // Volume metrics
    const buyNotional30s = window.trades30s
      .filter((t) => t.side === 'BUY')
      .reduce((sum, t) => sum + t.notional, 0);
    const sellNotional30s = window.trades30s
      .filter((t) => t.side === 'SELL')
      .reduce((sum, t) => sum + t.notional, 0);
    const cvd30s = buyNotional30s - sellNotional30s;

    const buyNotional1m = window.trades1m
      .filter((t) => t.side === 'BUY')
      .reduce((sum, t) => sum + t.notional, 0);
    const sellNotional1m = window.trades1m
      .filter((t) => t.side === 'SELL')
      .reduce((sum, t) => sum + t.notional, 0);
    const cvd1m = buyNotional1m - sellNotional1m;

    // Book metrics
    let bookImbalance = 0;
    let microprice = currentPrice;
    let spread = 0;
    let spreadPct = 0;

    if (book) {
      const bidQty = book.bids
        .slice(0, 5)
        .reduce((sum, [, qty]) => sum + qty, 0);
      const askQty = book.asks
        .slice(0, 5)
        .reduce((sum, [, qty]) => sum + qty, 0);
      const totalQty = bidQty + askQty;

      if (totalQty > 0) {
        bookImbalance = (bidQty - askQty) / totalQty;
      }

      const bestBid = book.bids[0]?.[0] || 0;
      const bestAsk = book.asks[0]?.[0] || 0;

      if (bestBid > 0 && bestAsk > 0) {
        // Microprice: weighted mid based on imbalance
        const bidWeight = askQty / totalQty; // If more asks, bid weighted higher
        const askWeight = bidQty / totalQty;
        microprice = bestBid * bidWeight + bestAsk * askWeight;
        spread = book.spread;
        spreadPct = book.spreadPct;
      }
    }

    // Stall detection metrics
    const { high, low, mid } = window.priceRange10s;
    let stallRangePct10s = 0;
    if (mid > 0 && high > 0 && low < Infinity) {
      stallRangePct10s = (high - low) / mid;
    }

    // Book replenish score: how stable is top-of-book qty
    const bookReplenishScore10s = this.calcReplenishScore(
      window.bookSnapshots10s,
    );

    // Context
    const openInterest = state.openInterest?.openInterest || 0;
    const fundingRate = state.fundingRate?.rate || 0;

    return {
      ts: now,
      symbol,
      px: currentPrice,
      ret5s,
      ret30s,
      ret1m,
      rv30s,
      rv1m,
      liqNotional30s,
      liqCount30s,
      liqNotional1m,
      buyNotional30s,
      sellNotional30s,
      cvd30s,
      cvd1m,
      bookImbalance,
      microprice,
      spread,
      spreadPct,
      stallRangePct10s,
      bookReplenishScore10s,
      openInterest,
      fundingRate,
    };
  }

  private calcReturn(
    prices: { ts: number; price: number }[],
    currentPrice: number,
    windowMs: number,
  ): number {
    if (prices.length === 0 || currentPrice === 0) return 0;

    const now = Date.now();
    const cutoff = now - windowMs;
    const oldPrices = prices.filter((p) => p.ts <= cutoff);

    if (oldPrices.length === 0) {
      // Use oldest available
      const oldest = prices[0];
      if (oldest && oldest.price > 0) {
        return (currentPrice - oldest.price) / oldest.price;
      }
      return 0;
    }

    const oldPrice = oldPrices[oldPrices.length - 1]!.price;
    if (oldPrice === 0) return 0;

    return (currentPrice - oldPrice) / oldPrice;
  }

  private calcRealizedVol(prices: number[]): number {
    if (prices.length < 2) return 0;

    // Calculate log returns
    const logReturns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      const prev = prices[i - 1]!;
      const curr = prices[i]!;
      if (prev > 0 && curr > 0) {
        logReturns.push(Math.log(curr / prev));
      }
    }

    if (logReturns.length === 0) return 0;

    return MathUtils.stdDev(logReturns);
  }

  private calcReplenishScore(
    snapshots: { ts: number; topBidQty: number; topAskQty: number }[],
  ): number {
    if (snapshots.length < 2) return 0.5; // neutral

    // Simple heuristic: coefficient of variation of top-of-book qty
    // Lower CV = more stable = higher replenish score
    const bidQtys = snapshots.map((s) => s.topBidQty);
    const askQtys = snapshots.map((s) => s.topAskQty);

    const bidMean = bidQtys.reduce((a, b) => a + b, 0) / bidQtys.length;
    const askMean = askQtys.reduce((a, b) => a + b, 0) / askQtys.length;

    if (bidMean === 0 && askMean === 0) return 0;

    const bidStd = MathUtils.stdDev(bidQtys);
    const askStd = MathUtils.stdDev(askQtys);

    const bidCV = bidMean > 0 ? bidStd / bidMean : 1;
    const askCV = askMean > 0 ? askStd / askMean : 1;

    const avgCV = (bidCV + askCV) / 2;

    // Convert CV to score: lower CV = higher score
    // CV of 0 = score 1, CV of 1+ = score 0
    return Math.max(0, Math.min(1, 1 - avgCV));
  }

  // ==================== Baseline Calculation ====================

  private async recalculateBaselines(): Promise<void> {
    for (const symbol of this.config.symbols) {
      const window = this.windows.get(symbol);
      if (!window) continue;

      const baselines = this.baselines.get(symbol);
      if (!baselines) continue;

      // Calculate 1h liquidation baselines from liqs1h
      const liqNotionals: number[] = [];
      // Group liqs into 30s buckets and sum
      const bucketSize = 30 * 1000;
      const buckets = new Map<number, number>();

      for (const liq of window.liqs1h) {
        const bucket = Math.floor(liq.ts / bucketSize) * bucketSize;
        buckets.set(bucket, (buckets.get(bucket) || 0) + liq.notional);
      }

      for (const notional of buckets.values()) {
        liqNotionals.push(notional);
      }

      if (liqNotionals.length > 0) {
        baselines.medianLiqNotional30s1h = MathUtils.median(liqNotionals);
        baselines.p90LiqNotional30s1h = MathUtils.percentile(liqNotionals, 90);
      }

      // Calculate 24h volatility baselines from rvHistory
      const rvHist = this.rvHistory.get(symbol);
      if (rvHist && rvHist.length > 0) {
        const rvValues = rvHist.map((h) => h.rv);
        baselines.medianRv30s24h = MathUtils.median(rvValues);
        baselines.p90Rv30s24h = MathUtils.percentile(rvValues, 90);
      }

      baselines.updatedAt = Date.now();
      this.baselines.set(symbol, baselines);
    }
  }

  /**
   * Record volatility sample for 24h percentile calculation
   */
  private recordVolatilitySample(symbol: string, rv: number, ts: number): void {
    if (rv <= 0) return;

    let history = this.rvHistory.get(symbol);
    if (!history) {
      history = [];
      this.rvHistory.set(symbol, history);
    }

    // Only record every 30 seconds to avoid too many samples
    const lastSample = history[history.length - 1];
    if (lastSample && ts - lastSample.ts < 30000) {
      return;
    }

    history.push({ ts, rv });

    // Prune old samples
    const cutoff = ts - this.RV_HISTORY_WINDOW_MS;
    this.rvHistory.set(
      symbol,
      history.filter((h) => h.ts > cutoff),
    );
  }

  // ==================== Public API ====================

  getFeatures(symbol: string): Features | undefined {
    return this.lastFeatures.get(symbol);
  }

  getBaselines(symbol: string): FeatureBaselines | undefined {
    return this.baselines.get(symbol);
  }
}
