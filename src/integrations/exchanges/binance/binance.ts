import { injectable, inject } from 'tsyringe';
import {
  USDMClient,
  WebsocketClient,
  WsMessageFuturesUserDataEventFormatted,
  FuturesExchangeInfo,
  FuturesSymbolExchangeInfo,
} from 'binance';
import Decimal from 'decimal.js';
import { get } from 'lodash';

import { TOKENS } from '../../../di/tokens';
import { ConfigService } from '../../../config';
import { Logger, ILogger } from '../../../infra/logger/logger';
import { EventBus } from '../../../infra/event-bus/event-bus';
import { RetryUtils } from '../../../infra/utils';
import {
  NormalizedTick,
  OrderBookSnap,
  LiqPrint,
  OpenInterestData,
  FundingRateData,
} from '../../../domain/market-data/market-data.types';

// Binance WS message types (beautified format from binance library)
interface BinanceAggTrade {
  eventType: string;
  eventTime: number;
  symbol: string;
  tradeId: number;
  price: number | string;
  quantity: number | string;
  firstTradeId: number;
  lastTradeId: number;
  time: number;
  maker: boolean;
  // Raw format fallback
  e?: string;
  s?: string;
  p?: string;
  q?: string;
  a?: number;
  T?: number;
  m?: boolean;
}

interface BinanceForceOrder {
  eventType: string;
  eventTime: number;
  order: {
    symbol: string;
    side: string;
    orderType: string;
    timeInForce: string;
    quantity: string;
    price: string;
    averagePrice: string;
    orderStatus: string;
    lastFilledQuantity: string;
    accumulatedFilledQuantity: string;
    tradeTime: number;
  };
  // Raw format fallback
  e?: string;
  o?: {
    s: string;
    S: string;
    o: string;
    f: string;
    q: string;
    p: string;
    ap: string;
    X: string;
    l: string;
    z: string;
    T: number;
  };
}

interface BinanceDepthUpdate {
  eventType: string;
  eventTime: number;
  symbol: string;
  firstUpdateId: number;
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
  // Raw format fallback
  e?: string;
  s?: string;
  U?: number;
  u?: number;
  b?: [string, string][];
  a?: [string, string][];
}

export type AggTradeCallback = (tick: NormalizedTick) => void;
export type LiquidationCallback = (liq: LiqPrint) => void;
export type BookCallback = (book: OrderBookSnap) => void;

@injectable()
export class BinanceClient {
  private readonly restClient: USDMClient;
  private wsClient: WebsocketClient | null = null;
  private readonly logger: ILogger;
  private isConnectedFlag = false;
  private marketsCache: Map<string, FuturesSymbolExchangeInfo> = new Map();

  // Callbacks for WS streams
  private aggTradeCallbacks: Map<string, AggTradeCallback[]> = new Map();
  private liqCallbacks: Map<string, LiquidationCallback[]> = new Map();
  private bookCallbacks: Map<string, BookCallback[]> = new Map();

  // Track subscriptions
  private activeSubscriptions: Set<string> = new Set();

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
  ) {
    this.logger = logger.child('Binance');

    this.restClient = new USDMClient({
      api_key: config.exchange.apiKey,
      api_secret: config.exchange.secret,
      testnet: config.exchange.testnet,
    });
  }

  // ==================== Connection ====================

  async connect(): Promise<void> {
    if (this.isConnectedFlag) {
      this.logger.warn('Already connected to Binance');
      return;
    }

    try {
      this.logger.info('Connecting to Binance USDM Futures...', {
        testnet: this.config.exchange.testnet,
      });

      // Load markets
      await this.loadMarkets();

      // Initialize WebSocket client
      this.wsClient = new WebsocketClient({
        api_key: this.config.exchange.apiKey,
        api_secret: this.config.exchange.secret,
        beautify: true,
      });

      this.setupWsEventHandlers();

      this.isConnectedFlag = true;
      this.logger.info(
        `Connected to Binance. Loaded ${this.marketsCache.size} markets`,
      );
    } catch (error) {
      this.logger.error('Failed to connect to Binance', error as Error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      this.logger.info('Disconnecting from Binance...');

      if (this.wsClient) {
        this.wsClient.closeAll();
        this.wsClient = null;
      }

      this.aggTradeCallbacks.clear();
      this.liqCallbacks.clear();
      this.bookCallbacks.clear();
      this.activeSubscriptions.clear();
      this.marketsCache.clear();

      this.isConnectedFlag = false;
      this.logger.info('Disconnected from Binance');
    } catch (error) {
      this.logger.error('Error during disconnect', error as Error);
    }
  }

  isConnected(): boolean {
    return this.isConnectedFlag && this.marketsCache.size > 0;
  }

  // ==================== Market Data REST ====================

  private async loadMarkets(): Promise<void> {
    const exchangeInfo: FuturesExchangeInfo = await RetryUtils.retry(
      () => this.restClient.getExchangeInfo(),
      { maxRetries: 3, baseDelay: 500 },
    );

    const activeSymbols = exchangeInfo.symbols.filter(
      (s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING',
    );

    this.marketsCache.clear();
    for (const symbol of activeSymbols) {
      const standardSymbol = this.symbolFromBinance(symbol.symbol);
      this.marketsCache.set(standardSymbol, symbol);
    }

    this.logger.info(`Loaded ${this.marketsCache.size} perpetual markets`);
  }

  async getOpenInterest(symbol: string): Promise<OpenInterestData> {
    const binanceSymbol = this.symbolToBinance(symbol);

    const [oiData, ticker] = await Promise.all([
      RetryUtils.retry(
        () => this.restClient.getOpenInterest({ symbol: binanceSymbol }),
        { maxRetries: 2, baseDelay: 300 },
      ),
      this.getCurrentPrice(symbol),
    ]);

    const oi = parseFloat(oiData.openInterest.toString());

    return {
      ts: Date.now(),
      symbol,
      openInterest: oi,
      openInterestUsdc: oi * ticker.toNumber(),
    };
  }

  async getFundingRate(symbol: string): Promise<FundingRateData> {
    const binanceSymbol = this.symbolToBinance(symbol);

    const markPrice = await RetryUtils.retry(
      () => this.restClient.getMarkPrice({ symbol: binanceSymbol }),
      { maxRetries: 2, baseDelay: 300 },
    );

    // Handle array response (when no symbol filter)
    const data = Array.isArray(markPrice) ? markPrice[0] : markPrice;

    return {
      ts: Date.now(),
      symbol,
      rate: parseFloat(data?.lastFundingRate?.toString() || '0'),
      nextFundingTime: Number(data?.nextFundingTime || 0),
    };
  }

  async getCurrentPrice(symbol: string): Promise<Decimal> {
    const binanceSymbol = this.symbolToBinance(symbol);

    const ticker = await RetryUtils.retry(
      () => this.restClient.getSymbolOrderBookTicker({ symbol: binanceSymbol }),
      { maxRetries: 2, baseDelay: 300 },
    );

    const bid = parseFloat(ticker.bidPrice.toString());
    const ask = parseFloat(ticker.askPrice.toString());

    return new Decimal((bid + ask) / 2);
  }

  private async getBestBidAsk(symbol: string): Promise<{
    bid: number;
    ask: number;
  }> {
    const binanceSymbol = this.symbolToBinance(symbol);

    const ticker = await RetryUtils.retry(
      () => this.restClient.getSymbolOrderBookTicker({ symbol: binanceSymbol }),
      { maxRetries: 2, baseDelay: 300 },
    );

    return {
      bid: parseFloat(ticker.bidPrice.toString()),
      ask: parseFloat(ticker.askPrice.toString()),
    };
  }

  async getOrder(
    symbol: string,
    orderId: string,
  ): Promise<{
    status: string;
    avgPrice: number;
    filledQty: number;
    price: number;
  }> {
    const binanceSymbol = this.symbolToBinance(symbol);

    const order = await RetryUtils.retry(
      () =>
        this.restClient.getOrder({
          symbol: binanceSymbol,
          orderId: parseInt(orderId, 10),
        }),
      { maxRetries: 2, baseDelay: 200 },
    );

    return {
      status: order.status?.toString() || 'UNKNOWN',
      avgPrice: parseFloat(order.avgPrice?.toString() || '0'),
      filledQty: parseFloat(order.executedQty?.toString() || '0'),
      price: parseFloat(order.price?.toString() || '0'),
    };
  }

  /**
   * Aggressive limit entry with retries and optional market fallback.
   */
  async createAggressiveLimitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    options: {
      maxRetries?: number;
      retryIntervalMs?: number;
      fallbackToMarket?: boolean;
      maxSlippagePct?: number;
      priceImprovementPct?: number;
    } = {},
  ): Promise<{
    avgPrice: number;
    filledQty: number;
    fees: number;
    usedMarketFallback: boolean;
  }> {
    const {
      maxRetries = 2,
      retryIntervalMs = 300,
      fallbackToMarket = true,
      maxSlippagePct = 0.15,
      priceImprovementPct = 0.01,
    } = options;

    const initialBook = await this.getBestBidAsk(symbol);
    const initialPrice = side === 'BUY' ? initialBook.ask : initialBook.bid;

    let remainingQty = quantity;
    let totalFilled = 0;
    let totalCost = 0;
    let totalFees = 0;
    let usedMarketFallback = false;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (remainingQty <= 0) break;

      const book = await this.getBestBidAsk(symbol);
      let limitPrice: number;

      if (side === 'BUY') {
        limitPrice = book.bid * (1 + priceImprovementPct / 100);
        limitPrice = Math.min(limitPrice, book.ask * 0.9999);
      } else {
        limitPrice = book.ask * (1 - priceImprovementPct / 100);
        limitPrice = Math.max(limitPrice, book.bid * 1.0001);
      }

      const worstAcceptable =
        side === 'BUY'
          ? initialPrice * (1 + maxSlippagePct / 100)
          : initialPrice * (1 - maxSlippagePct / 100);
      const slippageExceeded =
        side === 'BUY'
          ? limitPrice > worstAcceptable
          : limitPrice < worstAcceptable;

      if (slippageExceeded) {
        this.logger.warn('Aggressive limit slippage exceeded', {
          symbol,
          side,
          limitPrice: limitPrice.toFixed(4),
          initialPrice: initialPrice.toFixed(4),
          maxSlippagePct,
          fallbackToMarket,
        });

        if (fallbackToMarket) {
          break;
        }
        throw new Error(
          `Aggressive limit slippage exceeded ${maxSlippagePct}%`,
        );
      }

      const order = await this.restClient.submitNewOrder({
        symbol: this.symbolToBinance(symbol),
        side,
        type: 'LIMIT',
        quantity: remainingQty,
        price: limitPrice,
        timeInForce: 'GTC',
      });

      const orderId = order.orderId?.toString();
      if (!orderId) {
        throw new Error('Limit order missing orderId');
      }

      await RetryUtils.sleep(retryIntervalMs);

      const status = await this.getOrder(symbol, orderId);
      const filledQty = status.filledQty;
      const fillPrice =
        status.avgPrice > 0 ? status.avgPrice : status.price || limitPrice;

      if (filledQty > 0) {
        totalFilled += filledQty;
        totalCost += fillPrice * filledQty;
        remainingQty = Math.max(0, remainingQty - filledQty);
      }

      if (status.status === 'FILLED') {
        break;
      }

      try {
        await this.cancelOrder(symbol, orderId);
      } catch (error) {
        this.logger.debug('Failed to cancel stale limit order', {
          symbol,
          orderId,
          error: (error as Error).message,
        });
      }
    }

    if (remainingQty > 0) {
      if (!fallbackToMarket) {
        throw new Error(
          'Aggressive limit not filled and market fallback disabled',
        );
      }

      usedMarketFallback = true;
      const marketRes = await this.createMarketOrder(
        symbol,
        side,
        remainingQty,
      );
      totalFilled += marketRes.filledQty;
      totalCost += marketRes.avgPrice * marketRes.filledQty;
      totalFees += marketRes.fees;
      remainingQty = 0;
    }

    const avgPrice = totalFilled > 0 ? totalCost / totalFilled : 0;

    return {
      avgPrice,
      filledQty: totalFilled,
      fees: totalFees,
      usedMarketFallback,
    };
  }

  async getOrderBook(
    symbol: string,
    limit: number = 20,
  ): Promise<OrderBookSnap> {
    const binanceSymbol = this.symbolToBinance(symbol);

    const book = await RetryUtils.retry(
      () =>
        this.restClient.getOrderBook({
          symbol: binanceSymbol,
          limit: limit as 5 | 10 | 20 | 50 | 100 | 500 | 1000,
        }),
      { maxRetries: 2, baseDelay: 300 },
    );

    const bids: [number, number][] = book.bids.map((b: any) => [
      parseFloat(b[0]),
      parseFloat(b[1]),
    ]);
    const asks: [number, number][] = book.asks.map((a: any) => [
      parseFloat(a[0]),
      parseFloat(a[1]),
    ]);

    const bestBid = bids[0]?.[0] || 0;
    const bestAsk = asks[0]?.[0] || 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;

    return {
      ts: Date.now(),
      symbol,
      bids,
      asks,
      midPrice,
      spread,
      spreadPct: midPrice > 0 ? spread / midPrice : 0,
    };
  }

  // ==================== WebSocket Subscriptions ====================

  subscribeAggTrades(symbol: string, callback: AggTradeCallback): void {
    if (!this.wsClient) {
      throw new Error('WebSocket client not initialized');
    }

    const binanceSymbol = this.symbolToBinance(symbol).toLowerCase();
    const subKey = `aggTrade:${symbol}`;

    // Add callback
    if (!this.aggTradeCallbacks.has(symbol)) {
      this.aggTradeCallbacks.set(symbol, []);
    }
    this.aggTradeCallbacks.get(symbol)!.push(callback);

    // Subscribe if not already
    if (!this.activeSubscriptions.has(subKey)) {
      this.wsClient.subscribeAggregateTrades(binanceSymbol, 'usdm');
      this.activeSubscriptions.add(subKey);
      this.logger.info(`Subscribed to aggTrades: ${symbol}`);
    }
  }

  subscribeLiquidations(symbol: string, callback: LiquidationCallback): void {
    if (!this.wsClient) {
      throw new Error('WebSocket client not initialized');
    }

    const binanceSymbol = this.symbolToBinance(symbol).toLowerCase();
    const subKey = `forceOrder:${symbol}`;

    if (!this.liqCallbacks.has(symbol)) {
      this.liqCallbacks.set(symbol, []);
    }
    this.liqCallbacks.get(symbol)!.push(callback);

    if (!this.activeSubscriptions.has(subKey)) {
      this.wsClient.subscribeAllLiquidationOrders('usdm');
      this.activeSubscriptions.add(subKey);
      this.logger.info(`Subscribed to liquidations: ${symbol}`);
    }
  }

  subscribeOrderBook(
    symbol: string,
    callback: BookCallback,
    depth: number = 20,
  ): void {
    if (!this.wsClient) {
      throw new Error('WebSocket client not initialized');
    }

    const binanceSymbol = this.symbolToBinance(symbol).toLowerCase();
    const subKey = `depth:${symbol}`;

    if (!this.bookCallbacks.has(symbol)) {
      this.bookCallbacks.set(symbol, []);
    }
    this.bookCallbacks.get(symbol)!.push(callback);

    if (!this.activeSubscriptions.has(subKey)) {
      // Subscribe to partial book depth updates
      this.wsClient.subscribePartialBookDepths(
        binanceSymbol,
        depth as 5 | 10 | 20,
        100,
        'usdm',
      );
      this.activeSubscriptions.add(subKey);
      this.logger.info(`Subscribed to orderbook depth: ${symbol}`);
    }
  }

  // ==================== WebSocket Event Handlers ====================

  private setupWsEventHandlers(): void {
    if (!this.wsClient) return;

    this.wsClient.on('open', (data) => {
      this.logger.debug('WebSocket opened', { wsKey: data.wsKey });
    });

    this.wsClient.on('reconnecting', (data) => {
      this.logger.warn('WebSocket reconnecting', { wsKey: data?.wsKey });
      this.eventBus.emit('ws.reconnect', {
        scope: 'all',
        stage: 'reconnecting',
        wsKey: data?.wsKey,
        timestamp: Date.now(),
      });
    });

    this.wsClient.on('reconnected', (data) => {
      this.logger.info('WebSocket reconnected', { wsKey: data?.wsKey });
      this.eventBus.emit('ws.reconnect', {
        scope: 'all',
        stage: 'reconnected',
        wsKey: data?.wsKey,
        timestamp: Date.now(),
      });
    });

    (this.wsClient as any).on('error', (error: any) => {
      this.logger.error('WebSocket error', error as Error);
    });

    this.wsClient.on('formattedMessage', (data: any) => {
      this.handleWsMessage(data);
    });
  }

  private handleWsMessage(data: any): void {
    try {
      const eventType = data.e || data.eventType;

      switch (eventType) {
        case 'aggTrade':
          this.handleAggTrade(data as BinanceAggTrade);
          break;
        case 'forceOrder':
          this.handleForceOrder(data as BinanceForceOrder);
          break;
        case 'depthUpdate':
          this.handleDepthUpdate(data as BinanceDepthUpdate);
          break;
        default:
          // Handle partial book depth snapshot
          if (data.lastUpdateId && data.bids && data.asks) {
            this.handlePartialBook(data);
          }
      }
    } catch (error) {
      this.logger.error('Error handling WS message', error as Error, { data });
    }
  }

  private handleAggTrade(data: BinanceAggTrade): void {
    // Handle both beautified and raw formats
    const binanceSymbol = data.symbol || data.s;
    if (!binanceSymbol) {
      this.logger.debug('AggTrade missing symbol', { data });
      return;
    }

    const symbol = this.symbolFromBinance(binanceSymbol);
    const callbacks = this.aggTradeCallbacks.get(symbol);
    if (!callbacks || callbacks.length === 0) return;

    const price =
      typeof data.price === 'number'
        ? data.price
        : parseFloat(data.price || data.p || '0');
    const qty =
      typeof data.quantity === 'number'
        ? data.quantity
        : parseFloat(data.quantity || data.q || '0');
    const isMaker = data.maker !== undefined ? data.maker : data.m;
    const tradeTime = data.time || data.T || Date.now();
    const tradeId = data.tradeId || data.a || 0;

    const tick: NormalizedTick = {
      ts: tradeTime,
      symbol,
      price,
      qty,
      side: isMaker ? 'SELL' : 'BUY', // maker=true means buyer is maker, so taker is seller
      tradeId: tradeId.toString(),
      notionalUsdc: price * qty,
    };

    callbacks.forEach((cb) => cb(tick));

    // Also emit event
    this.eventBus.emit('tick.normalized', tick);
  }

  private handleForceOrder(data: any): void {
    // Handle beautified format (liquidationOrder) and raw format (o)
    const orderData = data.liquidationOrder || data.order || data.o;
    if (!orderData) {
      this.logger.debug('ForceOrder missing order data', { data });
      return;
    }

    const binanceSymbol = orderData.symbol || orderData.s;
    if (!binanceSymbol) return;

    const symbol = this.symbolFromBinance(binanceSymbol);
    const callbacks = this.liqCallbacks.get(symbol);
    if (!callbacks || callbacks.length === 0) return;

    const side = orderData.side || orderData.S;
    const avgPrice = orderData.averagePrice || orderData.ap;
    const orderPrice = orderData.price || orderData.p;
    const quantity = orderData.quantity || orderData.q;
    const tradeTime = orderData.orderTradeTime || orderData.T || Date.now();

    const price = parseFloat(avgPrice || orderPrice || '0');
    const qty = parseFloat(quantity || '0');

    const liq: LiqPrint = {
      ts: tradeTime,
      symbol,
      side: side === 'SELL' ? 'LONG_LIQ' : 'SHORT_LIQ',
      price,
      qty,
      notionalUsdc: price * qty,
    };

    callbacks.forEach((cb) => cb(liq));

    // Also emit event
    this.eventBus.emit('liq.print', liq);
  }

  private handleDepthUpdate(data: BinanceDepthUpdate): void {
    // With beautify:true, partial depth comes as bidDepthDelta/askDepthDelta
    // with objects {price, quantity} instead of arrays [price, qty]
    const bidDepthDelta = (data as any).bidDepthDelta;
    const askDepthDelta = (data as any).askDepthDelta;

    if (Array.isArray(bidDepthDelta) && Array.isArray(askDepthDelta)) {
      // Beautified format: [{price, quantity}, ...]
      const binanceSymbol = (data as any).symbol || data.s;
      if (!binanceSymbol) {
        this.logger.debug('DepthUpdate missing symbol', { data });
        return;
      }

      const symbol = this.symbolFromBinance(binanceSymbol);
      const callbacks = this.bookCallbacks.get(symbol);
      if (!callbacks || callbacks.length === 0) return;

      // Convert from {price, quantity} objects to [price, qty] arrays
      const bids: [number, number][] = bidDepthDelta.map((b: any) => [
        Number(b.price),
        Number(b.quantity),
      ]);
      const asks: [number, number][] = askDepthDelta.map((a: any) => [
        Number(a.price),
        Number(a.quantity),
      ]);

      const bestBid = bids[0]?.[0] || 0;
      const bestAsk = asks[0]?.[0] || 0;
      const midPrice = (bestBid + bestAsk) / 2;
      const spread = bestAsk - bestBid;

      const book: OrderBookSnap = {
        ts: Date.now(),
        symbol,
        bids,
        asks,
        midPrice,
        spread,
        spreadPct: midPrice > 0 ? spread / midPrice : 0,
        updateId: (data as any).lastUpdateId,
      };

      callbacks.forEach((cb) => cb(book));
      this.eventBus.emit('book.snapshot', book);
      return;
    }

    // Fallback: raw format with bids/asks as arrays
    this.handlePartialBook(data);
  }

  private handlePartialBook(data: any): void {
    // data has: symbol, lastUpdateId, bids[], asks[]
    const binanceSymbol = data.symbol || data.s;
    if (!binanceSymbol) {
      this.logger.debug('PartialBook missing symbol', { data });
      return;
    }

    const symbol = this.symbolFromBinance(binanceSymbol);
    const callbacks = this.bookCallbacks.get(symbol);
    if (!callbacks || callbacks.length === 0) return;

    const bids: [number, number][] = (data.bids || data.b || []).map(
      (b: any) => [parseFloat(b[0]), parseFloat(b[1])],
    );
    const asks: [number, number][] = (data.asks || data.a || []).map(
      (a: any) => [parseFloat(a[0]), parseFloat(a[1])],
    );

    const bestBid = bids[0]?.[0] || 0;
    const bestAsk = asks[0]?.[0] || 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;

    const rawUpdateId = data.lastUpdateId || data.u;
    const parsedUpdateId =
      rawUpdateId !== undefined ? Number(rawUpdateId) : undefined;
    const book: OrderBookSnap = {
      ts: Date.now(),
      symbol,
      bids,
      asks,
      midPrice,
      spread,
      spreadPct: midPrice > 0 ? spread / midPrice : 0,
      updateId: Number.isFinite(parsedUpdateId) ? parsedUpdateId : undefined,
    };

    callbacks.forEach((cb) => cb(book));

    // Also emit event
    this.eventBus.emit('book.snapshot', book);
  }

  // ==================== Symbol Conversion ====================

  symbolToBinance(symbol: string): string {
    // ETH/USDT:USDT -> ETHUSDT
    return symbol.replace('/', '').replace(':USDT', '');
  }

  private symbolFromBinance(binanceSymbol: string): string {
    // ETHUSDT -> ETH/USDT:USDT
    if (!binanceSymbol.endsWith('USDT')) {
      return binanceSymbol;
    }
    const base = binanceSymbol.slice(0, -4);
    return `${base}/USDT:USDT`;
  }

  // ==================== Order Execution ====================

  async createMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
  ): Promise<{
    orderId: string;
    avgPrice: number;
    filledQty: number;
    fees: number;
  }> {
    const binanceSymbol = this.symbolToBinance(symbol);

    const order = await RetryUtils.retry(
      () =>
        this.restClient.submitNewOrder({
          symbol: binanceSymbol,
          side,
          type: 'MARKET',
          quantity,
        }),
      { maxRetries: 2, baseDelay: 200 },
    );

    // Calculate fees from commission
    let fees = 0;
    if ((order as any).fills && Array.isArray((order as any).fills)) {
      for (const fill of (order as any).fills) {
        const commission = parseFloat(fill.commission || '0');
        const commissionAsset = fill.commissionAsset;
        // If commission is in USDT, add directly; otherwise estimate
        if (commissionAsset === 'USDT') {
          fees += commission;
        } else {
          // For BNB or other assets, we'd need to convert - for now estimate
          fees += commission * parseFloat(order.avgPrice?.toString() || '0');
        }
      }
    }

    return {
      orderId: order.orderId.toString(),
      avgPrice: parseFloat(order.avgPrice?.toString() || '0'),
      filledQty: parseFloat(order.executedQty?.toString() || '0'),
      fees,
    };
  }

  async createStopMarketOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    stopPrice: number,
  ): Promise<{ orderId: string }> {
    const binanceSymbol = this.symbolToBinance(symbol);

    const order = await RetryUtils.retry(
      () =>
        this.restClient.submitNewOrder({
          symbol: binanceSymbol,
          side,
          type: 'STOP_MARKET',
          quantity,
          stopPrice,
        }),
      { maxRetries: 2, baseDelay: 200 },
    );

    return {
      orderId: order.orderId.toString(),
    };
  }

  async createTakeProfitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: number,
    stopPrice: number,
  ): Promise<{ orderId: string }> {
    const binanceSymbol = this.symbolToBinance(symbol);

    const order = await RetryUtils.retry(
      () =>
        this.restClient.submitNewOrder({
          symbol: binanceSymbol,
          side,
          type: 'TAKE_PROFIT_MARKET',
          quantity,
          stopPrice,
        }),
      { maxRetries: 2, baseDelay: 200 },
    );

    return {
      orderId: order.orderId.toString(),
    };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    const binanceSymbol = this.symbolToBinance(symbol);

    await RetryUtils.retry(
      () =>
        this.restClient.cancelOrder({
          symbol: binanceSymbol,
          orderId: parseInt(orderId, 10),
        }),
      { maxRetries: 2, baseDelay: 200 },
    );
  }

  async cancelAllOrders(symbol: string): Promise<void> {
    const binanceSymbol = this.symbolToBinance(symbol);

    await RetryUtils.retry(
      () => this.restClient.cancelAllOpenOrders({ symbol: binanceSymbol }),
      { maxRetries: 2, baseDelay: 200 },
    );
  }

  async getPosition(symbol: string): Promise<{
    qty: number;
    entryPrice: number;
    unrealizedPnl: number;
    leverage: number;
  } | null> {
    const binanceSymbol = this.symbolToBinance(symbol);

    const positions = await RetryUtils.retry(
      () => this.restClient.getPositionsV3({ symbol: binanceSymbol }),
      { maxRetries: 2, baseDelay: 200 },
    );

    const pos = positions.find(
      (p) => parseFloat(p.positionAmt?.toString() || '0') !== 0,
    );
    if (!pos) return null;

    return {
      qty: parseFloat(pos.positionAmt?.toString() || '0'),
      entryPrice: parseFloat(pos.entryPrice?.toString() || '0'),
      unrealizedPnl: parseFloat(pos.unRealizedProfit?.toString() || '0'),
      leverage: parseInt((pos as any).leverage?.toString() || '1', 10),
    };
  }

  async getBalance(
    asset: string = 'USDT',
  ): Promise<{ available: number; total: number }> {
    const balances = await RetryUtils.retry(
      () => this.restClient.getBalanceV3(),
      { maxRetries: 2, baseDelay: 200 },
    );

    const balance = balances.find((b) => b.asset === asset);
    if (!balance) return { available: 0, total: 0 };

    return {
      available: parseFloat(balance.availableBalance?.toString() || '0'),
      total: parseFloat(balance.balance?.toString() || '0'),
    };
  }
}
