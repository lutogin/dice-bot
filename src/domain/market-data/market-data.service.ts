import { injectable, inject } from 'tsyringe';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { EventBus } from '../../infra/event-bus/event-bus';
import { BinanceClient } from '../../integrations/exchanges/binance/binance';
import {
  NormalizedTick,
  OrderBookSnap,
  LiqPrint,
  OpenInterestData,
  FundingRateData,
  MarketState,
} from './market-data.types';

@injectable()
export class MarketDataService {
  private readonly logger: ILogger;
  private states: Map<string, MarketState> = new Map();
  private oiIntervalId: NodeJS.Timeout | null = null;
  private fundingIntervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.BINANCE_CLIENT) private binance: BinanceClient,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
  ) {
    this.logger = logger.child('MarketData');
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('MarketDataService already running');
      return;
    }

    this.logger.info('Starting MarketDataService...', {
      symbols: this.config.symbols,
    });

    // Initialize state for each symbol
    for (const symbol of this.config.symbols) {
      this.states.set(symbol, {
        symbol,
        lastPrice: 0,
        lastTick: null,
        lastBook: null,
        lastLiq: null,
        openInterest: null,
        fundingRate: null,
        updatedAt: 0,
      });
    }

    // Subscribe to WebSocket streams
    await this.subscribeToStreams();

    // Start polling for OI and funding
    this.startOIPoll();
    this.startFundingPoll();

    this.isRunning = true;
    this.logger.info('MarketDataService started');
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.logger.info('Stopping MarketDataService...');

    if (this.oiIntervalId) {
      clearInterval(this.oiIntervalId);
      this.oiIntervalId = null;
    }

    if (this.fundingIntervalId) {
      clearInterval(this.fundingIntervalId);
      this.fundingIntervalId = null;
    }

    this.states.clear();
    this.isRunning = false;
    this.logger.info('MarketDataService stopped');
  }

  private async subscribeToStreams(): Promise<void> {
    for (const symbol of this.config.symbols) {
      // Subscribe to trades
      this.binance.subscribeAggTrades(symbol, (tick) => {
        this.handleTick(tick);
      });

      // Subscribe to liquidations
      this.binance.subscribeLiquidations(symbol, (liq) => {
        this.handleLiquidation(liq);
      });

      // Subscribe to orderbook
      this.binance.subscribeOrderBook(
        symbol,
        (book) => {
          this.handleBook(book);
        },
        20,
      );

      this.logger.info(`Subscribed to streams for ${symbol}`);
    }
  }

  private handleTick(tick: NormalizedTick): void {
    const state = this.states.get(tick.symbol);
    if (!state) return;

    state.lastTick = tick;
    state.lastPrice = tick.price;
    state.updatedAt = tick.ts;

    // Event already emitted by BinanceClient
  }

  private handleLiquidation(liq: LiqPrint): void {
    const state = this.states.get(liq.symbol);
    if (!state) return;

    state.lastLiq = liq;
    state.updatedAt = liq.ts;

    this.logger.debug('Liquidation detected', {
      symbol: liq.symbol,
      side: liq.side,
      notional: liq.notionalUsdc.toFixed(0),
    });

    // Event already emitted by BinanceClient
  }

  private handleBook(book: OrderBookSnap): void {
    const state = this.states.get(book.symbol);
    if (!state) return;

    state.lastBook = book;
    state.updatedAt = book.ts;

    // Event already emitted by BinanceClient
  }

  private startOIPoll(): void {
    const intervalMs = this.config.features.oiPollIntervalSec * 1000;

    // Initial fetch
    this.fetchOpenInterest();

    this.oiIntervalId = setInterval(() => {
      this.fetchOpenInterest();
    }, intervalMs);

    this.logger.info(
      `OI polling started (every ${this.config.features.oiPollIntervalSec}s)`,
    );
  }

  private async fetchOpenInterest(): Promise<void> {
    for (const symbol of this.config.symbols) {
      try {
        const oi = await this.binance.getOpenInterest(symbol);
        const state = this.states.get(symbol);
        if (state) {
          state.openInterest = oi;
          state.updatedAt = oi.ts;
        }
      } catch (error) {
        this.logger.error(`Failed to fetch OI for ${symbol}`, error as Error);
      }
    }
  }

  private startFundingPoll(): void {
    const intervalMs = this.config.features.fundingPollIntervalSec * 1000;

    // Initial fetch
    this.fetchFundingRates();

    this.fundingIntervalId = setInterval(() => {
      this.fetchFundingRates();
    }, intervalMs);

    this.logger.info(
      `Funding rate polling started (every ${this.config.features.fundingPollIntervalSec}s)`,
    );
  }

  private async fetchFundingRates(): Promise<void> {
    for (const symbol of this.config.symbols) {
      try {
        const funding = await this.binance.getFundingRate(symbol);
        const state = this.states.get(symbol);
        if (state) {
          state.fundingRate = funding;
          state.updatedAt = funding.ts;
        }
      } catch (error) {
        this.logger.error(
          `Failed to fetch funding for ${symbol}`,
          error as Error,
        );
      }
    }
  }

  // ==================== Public Getters ====================

  getState(symbol: string): MarketState | undefined {
    return this.states.get(symbol);
  }

  getLastPrice(symbol: string): number {
    return this.states.get(symbol)?.lastPrice || 0;
  }

  getLastBook(symbol: string): OrderBookSnap | null {
    return this.states.get(symbol)?.lastBook || null;
  }

  getOpenInterest(symbol: string): OpenInterestData | null {
    return this.states.get(symbol)?.openInterest || null;
  }

  getFundingRate(symbol: string): FundingRateData | null {
    return this.states.get(symbol)?.fundingRate || null;
  }

  getAllSymbols(): string[] {
    return Array.from(this.states.keys());
  }
}
