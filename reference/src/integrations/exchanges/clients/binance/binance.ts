import { injectable, inject } from 'tsyringe';
import {
  USDMClient,
  WebsocketClient,
  FuturesPositionV3,
  FuturesSymbolExchangeInfo,
  FuturesExchangeInfo,
} from 'binance';
import Decimal from 'decimal.js';

import { ILogger, Logger } from '../../../../infra/logger/logger';
import { ConfigService } from '../../../../config';
import { TOKENS } from '../../../../di/tokens';
import type { HedgeExchangeConfig } from '../../../../config/config.types';
import {
  CreateOrderPayload,
  PositionOrderPayload,
  TickerCallback,
} from '../../common/exchange-client.interface';
import {
  Balance,
  FundingRateData,
  IOrder,
  IPosition,
  OrderSide,
  MarketData,
  OrderBookData,
  Trade,
} from '../../common/exchange.types';
import { RetryUtils } from '../../../../infra/utils';
import { NoPositionFound } from '../../common/exchange.errors';
import { get, isNil } from 'lodash';

// Interface for Book Ticker WebSocket data
interface BinanceBookTickerData {
  e: string; // Event type
  u: number; // order book updateId
  s: string; // symbol
  b: string; // best bid price
  B: string; // best bid qty
  a: string; // best ask price
  A: string; // best ask qty
  T: number; // Transaction time
  E: number; // Event time
}

/**
 * OHLCV candle data
 */
export interface OHLCVCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

@injectable()
export class BinanceClient {
  private readonly client: USDMClient;
  private wsClient: WebsocketClient | null = null;
  private wsCallbacks: Map<string, TickerCallback> = new Map();
  private wsActiveSubscriptions: Set<string> = new Set();
  protected marketsCache: Map<string, FuturesSymbolExchangeInfo> = new Map();
  private isHedgeModeEnabled = false;
  private logger: ILogger;
  private isConnectedFlag = false;
  private id: string = 'binance';
  private name: string = 'Binance';

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) configService: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger
  ) {
    const exchangeConfig = configService.hedgeExchange;
    // Init Logger
    this.logger = logger.child('Binance');
    this.client = new USDMClient({
      api_key: exchangeConfig.apiKey,
      api_secret: exchangeConfig.secret,
      testnet: exchangeConfig.testnet,
    });
  }

  createExchange(): any {
    return this.client;
  }

  /**
   * Check if the given ID is a client order ID (our format) vs Binance orderId (numeric)
   */
  private isClientOrderId(id: string): boolean {
    // Our client order IDs start with broker prefix 'x-r1wQQsTn' or 'x-' in general
    // Binance orderIds are purely numeric (but as strings)
    return id.startsWith('x-') || /[a-zA-Z_]/.test(id);
  }

  /**
   * Convert our symbol format to Binance format
   * BTC/USDT:USDT -> BTCUSDT
   */
  symbolToBinance(symbol: string): string {
    return symbol.replace('/', '').replace(':USDT', '');
  }

  /**
   * Convert Binance symbol format to our format
   * BTCUSDT -> BTC/USDT:USDT
   */
  private symbolFromBinance(binanceSymbol: string): string {
    if (!binanceSymbol.endsWith('USDT')) {
      return binanceSymbol; // Return as-is if not USDT pair
    }

    const base = binanceSymbol.slice(0, -4);
    return `${base}/USDT:USDT`;
  }

  // ==================== Connection Methods ====================

  async connect(): Promise<void> {
    try {
      this.logger.info('Connecting to Binance USDM Futures...');

      // Load markets
      await this.loadMarkets();
      await this.detectPositionMode();

      this.isConnectedFlag = true;
      this.logger.info(`Connected to Binance. Loaded ${this.marketsCache.size} markets`);
    } catch (error) {
      this.logger.error('Failed to connect to Binance', error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      this.logger.info('Disconnecting from Binance...');

      // Close WebSocket if exists
      if (this.wsClient) {
        this.wsClient.closeAll();
        this.wsClient = null;
      }

      this.wsCallbacks.clear();
      this.wsActiveSubscriptions.clear();
      this.marketsCache.clear();

      this.isConnectedFlag = false;
      this.logger.info('Disconnected from Binance');
    } catch (error) {
      this.logger.error('Error during Binance disconnect', error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  isConnected(): boolean {
    return this.isConnectedFlag && this.marketsCache.size > 0;
  }

  isHedgeMode(): boolean {
    return this.isHedgeModeEnabled;
  }

  private async detectPositionMode(): Promise<void> {
    try {
      const modeResponse = await this.client.getCurrentPositionMode();
      const rawValue =
        (modeResponse as any)?.dualSidePosition ??
        (modeResponse as any)?.dualSide ??
        (modeResponse as any)?.positionSideDual;
      const normalized = typeof rawValue === 'string'
        ? rawValue.toLowerCase() === 'true'
        : Boolean(rawValue);

      this.isHedgeModeEnabled = normalized;
      this.logger.info('Detected Binance position mode', {
        hedgeMode: this.isHedgeModeEnabled,
      });
    } catch (error) {
      this.logger.warn('Failed to detect Binance position mode; defaulting to one-way', {
        error: (error as Error).message,
      });
      this.isHedgeModeEnabled = false;
    }
  }

  // ==================== Market Data Methods ====================

  async loadMarkets(): Promise<void> {
    try {
      this.logger.info('Loading Binance USDM Futures markets...');

      const exchangeInfo: FuturesExchangeInfo = await RetryUtils.retry(
        () => this.client.getExchangeInfo(),
        {
          maxRetries: 3,
          baseDelay: 500,
          maxDelay: 2000,
        }
      );

      if (!exchangeInfo || !exchangeInfo.symbols) {
        throw new Error('Invalid response from Binance API');
      }

      // Filter only PERPETUAL contracts with TRADING status
      const activeSymbols = exchangeInfo.symbols.filter(
        (s: FuturesSymbolExchangeInfo) => s.contractType === 'PERPETUAL' && s.status === 'TRADING'
      );

      this.logger.info(`Found ${activeSymbols.length} active perpetual markets`);

      // Cache markets
      this.marketsCache.clear();
      for (const symbol of activeSymbols) {
        const standardSymbol = this.symbolFromBinance(symbol.symbol);
        this.marketsCache.set(standardSymbol, symbol);
      }

      this.logger.info(`Loaded ${this.marketsCache.size} Binance markets`);
    } catch (error) {
      this.logger.error('Failed to load Binance markets', error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  ensureConnected(): void {
    if (!this.isConnected()) {
      throw new Error('Not connected to Binance');
    }
  }

  async getFundingRates(symbols?: string[]): Promise<FundingRateData[]> {
    this.ensureConnected();

    try {
      // Get funding rate configs and mark prices
      const [fundingRateConfigs, markPrices] = await RetryUtils.retry(
        () => Promise.all([this.client.getFundingRates(), this.client.getMarkPrice()]),
        {
          maxRetries: 3,
          baseDelay: 500,
          maxDelay: 2000,
        }
      );

      // Create Map for quick lookup of funding intervals
      const fundingConfigMap = new Map(
        fundingRateConfigs.map(config => [config.symbol, config.fundingIntervalHours])
      );

      const results: FundingRateData[] = [];

      for (const markPrice of markPrices.filter(markData => markData.symbol.endsWith('USDT'))) {
        try {
          const standardSymbol = this.symbolFromBinance(markPrice.symbol);

          // Filter by symbols if provided
          if (symbols && symbols.length > 0 && !symbols.includes(standardSymbol)) {
            continue;
          }

          // Get funding interval for this symbol
          const fundingInterval = fundingConfigMap.get(markPrice.symbol);
          if (isNil(fundingInterval)) {
            continue;
          }

          if (
            isNil(markPrice.lastFundingRate) ||
            !markPrice.nextFundingTime ||
            markPrice.lastFundingRate === ''
          ) {
            this.logger.warn(`Missing funding rate data for ${markPrice.symbol}`, {
              fundingRate: markPrice.lastFundingRate,
              nextFundingTime: markPrice.nextFundingTime,
              fundingInterval: fundingInterval,
            });
            continue;
          }

          const fundingRate: FundingRateData = {
            symbol: standardSymbol,
            rate: new Decimal(markPrice.lastFundingRate.toString()),
            timestamp: Number(markPrice.time),
            nextFundingTime: Number(markPrice.nextFundingTime),
            exchangeId: this.id,
            fundingInterval: fundingInterval,
          };

          results.push(fundingRate);
        } catch (symbolError) {
          this.logger.error(`Failed to process symbol ${markPrice.symbol}:`, symbolError as Error, {
            body: get(symbolError, 'code'),
            code: get(symbolError, 'body.message'),
          });
        }
      }

      this.logger.debug(`Retrieved ${results.length} funding rates from ${this.name}`);
      return results;
    } catch (error) {
      this.logger.error(`Failed to get funding rates from ${this.name}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async getFundingRate(symbol: string): Promise<FundingRateData> {
    const rates = await this.getFundingRates([symbol]);
    if (rates.length === 0) {
      throw new Error(`Funding rate not found for ${symbol}`);
    }
    return rates[0]!;
  }

  async getMarketData(symbol: string): Promise<MarketData> {
    this.ensureConnected();

    try {
      const binanceSymbol = this.symbolToBinance(symbol);
      const marketData = await RetryUtils.retry(
        () => this.client.getSymbolOrderBookTicker({ symbol: binanceSymbol }),
        {
          maxRetries: 3,
          baseDelay: 500,
          maxDelay: 2000,
        }
      );

      return {
        symbol,
        bid: parseFloat(marketData.bidPrice.toString()),
        ask: parseFloat(marketData.askPrice.toString()),
        last: parseFloat(marketData.bidPrice.toString()),
        timestamp: marketData.time,
        exchangeId: this.id,
      };
    } catch (error) {
      this.logger.error(`Failed to get market data for ${symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async getOrderBook(symbol: string, limit: number = 20): Promise<OrderBookData> {
    this.ensureConnected();

    try {
      const binanceSymbol = this.symbolToBinance(symbol);
      const orderBook = await RetryUtils.retry(
        () =>
          this.client.getOrderBook({
            symbol: binanceSymbol,
            limit: limit as 5 | 10 | 20 | 50 | 100 | 500 | 1000 | 5000,
          }),
        {
          maxRetries: 3,
          baseDelay: 500,
          maxDelay: 2000,
        }
      );

      return {
        symbol,
        bids: orderBook.bids.map((bid: any) => [parseFloat(bid[0]), parseFloat(bid[1])]),
        asks: orderBook.asks.map((ask: any) => [parseFloat(ask[0]), parseFloat(ask[1])]),
        timestamp: orderBook.T || orderBook.E || Date.now(),
        exchangeId: this.id,
      };
    } catch (error) {
      this.logger.error(`Failed to get order book for ${symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async getCurrentPrice(symbol: string): Promise<Decimal> {
    const marketData = await this.getMarketData(symbol);
    return new Decimal(marketData.last);
  }

  // ==================== OHLCV & Volatility Methods ====================

  /**
   * Get OHLCV (candlestick) data for a symbol
   * Returns ONLY closed candles (excludes current open candle)
   *
   * @param symbol - Trading symbol (e.g., 'ETH/USDT:USDT')
   * @param timeframe - Candle timeframe (default: '30m')
   * @param limit - Number of closed candles to return (default: 48)
   * @returns Array of closed OHLCV candles
   */
  async getOHLCV(
    symbol: string,
    timeframe: string = '30m',
    limit: number = 48
  ): Promise<OHLCVCandle[]> {
    this.ensureConnected();

    try {
      const binanceSymbol = this.symbolToBinance(symbol);

      // Map common timeframe formats to Binance interval
      const intervalMap: Record<string, string> = {
        '1m': '1m',
        '3m': '3m',
        '5m': '5m',
        '15m': '15m',
        '30m': '30m',
        '1h': '1h',
        '2h': '2h',
        '4h': '4h',
        '6h': '6h',
        '8h': '8h',
        '12h': '12h',
        '1d': '1d',
        '3d': '3d',
        '1w': '1w',
        '1M': '1M',
      };

      const interval = intervalMap[timeframe] || timeframe;

      // Request one extra candle because the last one might be the current (open) candle
      const requestLimit = limit + 1;

      const klines = await RetryUtils.retry(
        () =>
          this.client.getKlines({
            symbol: binanceSymbol,
            interval: interval as any,
            limit: requestLimit,
          }),
        {
          maxRetries: 3,
          baseDelay: 500,
          maxDelay: 2000,
        }
      );

      if (!klines || klines.length === 0) {
        return [];
      }

      // Convert to OHLCV format
      const candles: OHLCVCandle[] = klines.map((kline: any) => ({
        timestamp: kline[0], // Open time
        open: parseFloat(kline[1]),
        high: parseFloat(kline[2]),
        low: parseFloat(kline[3]),
        close: parseFloat(kline[4]),
        volume: parseFloat(kline[5]),
      }));

      // Remove the last candle if it's the current (not yet closed) candle
      // A candle is considered "open" if its close time is in the future
      const now = Date.now();
      const filteredCandles = candles.filter(candle => {
        // Calculate the expected close time based on timeframe
        const closeTime = this.getExpectedCloseTime(candle.timestamp, interval);
        return closeTime <= now;
      });

      // Return only the requested number of closed candles (most recent)
      return filteredCandles.slice(-limit);
    } catch (error) {
      this.logger.error(`Failed to get OHLCV for ${symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  /**
   * Calculate expected close time for a candle based on its open time and interval
   */
  private getExpectedCloseTime(openTime: number, interval: string): number {
    const intervalMs: Record<string, number> = {
      '1m': 60 * 1000,
      '3m': 3 * 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '30m': 30 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '2h': 2 * 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '8h': 8 * 60 * 60 * 1000,
      '12h': 12 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000,
      '3d': 3 * 24 * 60 * 60 * 1000,
      '1w': 7 * 24 * 60 * 60 * 1000,
      '1M': 30 * 24 * 60 * 60 * 1000, // Approximate
    };

    const durationMs = intervalMs[interval] || 30 * 60 * 1000; // Default to 30m
    return openTime + durationMs;
  }

  /**
   * Calculate realized volatility from OHLCV data using log-returns
   *
   * Formula:
   * 1. Log-returns: r_i = ln(close_i / close_{i-1})
   * 2. Volatility: σ = stddev(r_1 ... r_n)
   *
   * @param symbol - Trading symbol (e.g., 'ETH/USDT:USDT')
   * @param timeframe - Candle timeframe (default: '30m')
   * @param limit - Number of closed candles to use (default: 48)
   * @returns Realized volatility as Decimal
   */
  async getVolatility(
    symbol: string,
    timeframe: string = '30m',
    limit: number = 48
  ): Promise<Decimal> {
    try {
      // Get closed candles
      const candles = await this.getOHLCV(symbol, timeframe, limit);

      if (candles.length < limit/2) {
        this.logger.warn('Not enough candles to calculate volatility', {
          symbol,
          candleCount: candles.length,
          required: limit/2,
        });
        return new Decimal(0);
      }

      // Calculate log-returns: r_i = ln(close_i / close_{i-1})
      const logReturns: Decimal[] = [];
      for (let i = 1; i < candles.length; i++) {
        const prevClose = candles[i - 1]!.close;
        const currClose = candles[i]!.close;

        if (prevClose > 0 && currClose > 0) {
          const logReturn = new Decimal(currClose).div(prevClose).ln();
          logReturns.push(logReturn);
        }
      }

      if (logReturns.length === 0) {
        return new Decimal(0);
      }

      // Calculate standard deviation of log-returns
      const volatility = this.calculateStdDev(logReturns);

      this.logger.debug('Volatility calculated', {
        symbol,
        timeframe,
        candleCount: candles.length,
        logReturnCount: logReturns.length,
        volatility: volatility.toFixed(6),
      });

      return volatility;
    } catch (error) {
      this.logger.error(`Failed to calculate volatility for ${symbol}`, error as Error);
      throw error;
    }
  }

  /**
   * Calculate standard deviation of an array of Decimal values
   */
  private calculateStdDev(values: Decimal[]): Decimal {
    if (values.length === 0) {
      return new Decimal(0);
    }

    const n = values.length;

    // Calculate mean
    const sum = values.reduce((acc, val) => acc.add(val), new Decimal(0));
    const mean = sum.div(n);

    // Calculate variance: sum((x_i - mean)^2) / (n - 1)
    // Using n-1 for sample standard deviation (Bessel's correction)
    const squaredDiffs = values.map(val => val.sub(mean).pow(2));
    const variance = squaredDiffs
      .reduce((acc, val) => acc.add(val), new Decimal(0))
      .div(n > 1 ? n - 1 : 1);

    // Standard deviation = sqrt(variance)
    return variance.sqrt();
  }

  // ==================== Account Methods ====================

  async getBalances(): Promise<Balance[]> {
    this.ensureConnected();

    try {
      // Use getBalanceV3 instead of deprecated getBalance/getAccountInformation
      const balanceData = await RetryUtils.retry(() => this.client.getBalanceV3(), {
        maxRetries: 3,
        baseDelay: 500,
        maxDelay: 2000,
      });

      const balances: Balance[] = balanceData.map((asset: any) => ({
        asset: asset.asset,
        free: parseFloat(asset.availableBalance?.toString() || '0'),
        used: parseFloat(asset.initialMargin?.toString() || '0'),
        total: parseFloat(asset.balance?.toString() || '0'),
      }));

      return balances;
    } catch (error) {
      this.logger.error('Failed to get balances from Binance', error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async getBalance(
    asset: string,
    options?: {
      type?: 'spot' | 'future' | 'swap' | 'margin';
      code?: string;
    }
  ): Promise<Balance> {
    const balances = await this.getBalances();
    const balance = balances.find(b => b.asset === asset);
    if (!balance) {
      return {
        asset,
        free: 0,
        used: 0,
        total: 0,
      };
    }
    return balance;
  }

  async getFuturesBalance(asset: string = 'USDT'): Promise<Balance> {
    return this.getBalance(asset, { type: 'future' });
  }

  /**
   * Get full futures account information including margin details
   * Returns equity, available balance, margin ratios, etc.
   */
  async getAccountInfo(): Promise<{
    totalWalletBalance: number;
    totalUnrealizedProfit: number;
    totalMarginBalance: number;
    totalInitialMargin: number;
    totalMaintMargin: number;
    totalPositionInitialMargin: number;
    totalOpenOrderInitialMargin: number;
    totalCrossWalletBalance: number;
    totalCrossUnPnl: number;
    availableBalance: number;
    maxWithdrawAmount: number;
  }> {
    this.ensureConnected();

    try {
      const accountInfo = await RetryUtils.retry(() => this.client.getAccountInformationV3(), {
        maxRetries: 3,
        baseDelay: 500,
        maxDelay: 2000,
      });

      return {
        totalWalletBalance: parseFloat(accountInfo.totalWalletBalance?.toString() || '0'),
        totalUnrealizedProfit: parseFloat(accountInfo.totalUnrealizedProfit?.toString() || '0'),
        totalMarginBalance: parseFloat(accountInfo.totalMarginBalance?.toString() || '0'),
        totalInitialMargin: parseFloat(accountInfo.totalInitialMargin?.toString() || '0'),
        totalMaintMargin: parseFloat(accountInfo.totalMaintMargin?.toString() || '0'),
        totalPositionInitialMargin: parseFloat(accountInfo.totalPositionInitialMargin?.toString() || '0'),
        totalOpenOrderInitialMargin: parseFloat(accountInfo.totalOpenOrderInitialMargin?.toString() || '0'),
        totalCrossWalletBalance: parseFloat(accountInfo.totalCrossWalletBalance?.toString() || '0'),
        totalCrossUnPnl: parseFloat(accountInfo.totalCrossUnPnl?.toString() || '0'),
        availableBalance: parseFloat(accountInfo.availableBalance?.toString() || '0'),
        maxWithdrawAmount: parseFloat(accountInfo.maxWithdrawAmount?.toString() || '0'),
      };
    } catch (error) {
      this.logger.error('Failed to get account info from Binance', error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async getPositions(params?: {
    symbol?: string;
    skipZeroPositions?: boolean;
  }): Promise<IPosition[]> {
    this.ensureConnected();

    try {
      const symbol = params?.symbol;
      const skipZeroPositions = params?.skipZeroPositions ?? true;

      // Use getPositionsV3 which returns complete position data including
      // entryPrice, liquidationPrice, markPrice (unlike getAccountInformationV3)
      const binanceSymbol = symbol ? this.symbolToBinance(symbol) : undefined;
      const positionsData = await RetryUtils.retry(
        () => this.client.getPositionsV3(binanceSymbol ? { symbol: binanceSymbol } : undefined),
        {
          maxRetries: 3,
          baseDelay: 500,
          maxDelay: 2000,
        }
      );

      // Convert Binance positions to IPosition format
      let positions = await Promise.all(
        positionsData.map(async (binancePos: FuturesPositionV3) => {
          // Get funding fees for positions with non-zero amount
          let fundingFees = 0;
          const posAmt = parseFloat(binancePos.positionAmt?.toString() || '0');
          if (posAmt !== 0) {
            try {
              const fundingHistory = await this.client.getIncomeHistory({
                symbol: binancePos.symbol,
                incomeType: 'FUNDING_FEE',
                limit: 100,
                startTime: Date.now() - 2 * 24 * 60 * 60 * 1000, // last 2 days
                endTime: Date.now(),
              });
              fundingFees = fundingHistory.reduce(
                (sum, item) => sum + parseFloat(item.income?.toString() || '0'),
                0
              );
            } catch {
              // Ignore funding fee errors
            }
          }

          return this.mapBinancePositionV3ToIPosition(binancePos, fundingFees);
        })
      );

      // Filter zero positions if requested
      if (skipZeroPositions) {
        positions = positions.filter(
          position =>
            (position?.contracts ?? 0) > 0 ||
            (position?.contractSize ?? 0) > 0 ||
            (position?.size ?? 0) > 0
        );
      }

      return positions;
    } catch (error) {
      this.logger.error(`Failed to get positions from Binance`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async getPosition(params?: {
    symbol: string;
    skipZeroPositions?: boolean;
  }): Promise<IPosition | null> {
    const positions = await this.getPositions({
      symbol: params?.symbol,
      skipZeroPositions: params?.skipZeroPositions,
    });
    return positions.length > 0 ? positions[0]! : null;
  }

  /**
   * Map FuturesPositionV3 to IPosition
   * This is the preferred mapper as V3 API returns complete position data
   * including entryPrice, liquidationPrice, and markPrice
   */
  private mapBinancePositionV3ToIPosition(
    binancePosition: FuturesPositionV3,
    fundingFees: number = 0
  ): IPosition {
    const symbol = this.symbolFromBinance(binancePosition.symbol);
    const positionAmt = parseFloat(binancePosition.positionAmt?.toString() || '0');
    const contracts = Math.abs(positionAmt);

    // Determine side based on position amount and positionSide
    let side: 'long' | 'short';
    if (binancePosition.positionSide === 'BOTH') {
      side = positionAmt >= 0 ? 'long' : 'short';
    } else {
      side = binancePosition.positionSide === 'LONG' ? 'long' : 'short';
    }

    // Determine margin type from isolated margin value
    const isolatedMargin = parseFloat(binancePosition.isolatedMargin?.toString() || '0');
    const marginType = isolatedMargin > 0 ? 'isolated' : 'cross';

    return {
      symbol,
      side,
      size: contracts,
      entryPrice: parseFloat(binancePosition.entryPrice?.toString() || '0'),
      markPrice: parseFloat(binancePosition.markPrice?.toString() || '0'),
      unrealizedPnl: parseFloat(binancePosition.unRealizedProfit?.toString() || '0'),
      marginType,
      leverage: 0, // V3 API doesn't return leverage directly, will be enriched from account info
      contracts,
      contractSize: 1, // For USDT-M, contractSize is always 1
      realizedPnl: fundingFees,
      liquidationPrice: parseFloat(binancePosition.liquidationPrice?.toString() || '0'),
      stopLossPrice: undefined,
      takeProfitPrice: undefined,
      exchangeId: this.id,
    };
  }

  /**
   * @deprecated Use mapBinancePositionV3ToIPosition instead
   */
  private mapBinancePositionToIPosition(binancePosition: FuturesPositionV3): IPosition {
    return this.mapBinancePositionV3ToIPosition(binancePosition, 0);
  }

  /**
   * Map position from getAccountInformation response (more complete data)
   */
  private mapBinanceAccountPositionToIPosition(
    binancePosition: any,
    fundingFees: number
  ): IPosition {
    const symbol = this.symbolFromBinance(binancePosition.symbol);
    const positionAmt = parseFloat(binancePosition.positionAmt?.toString() || '0');
    const contracts = Math.abs(positionAmt);

    // Determine side based on position amount and positionSide
    let side: 'long' | 'short';
    if (binancePosition.positionSide === 'BOTH') {
      side = positionAmt >= 0 ? 'long' : 'short';
    } else {
      side = binancePosition.positionSide === 'LONG' ? 'long' : 'short';
    }

    // Account endpoint provides leverage directly
    const leverage = parseFloat(binancePosition.leverage?.toString() || '0');

    // Determine margin type from isolated margin value or marginType field
    const marginType =
      binancePosition.marginType === 'isolated' ||
      parseFloat(binancePosition.isolatedMargin?.toString() || '0') > 0
        ? 'isolated'
        : 'cross';

    return {
      symbol,
      side,
      size: contracts,
      entryPrice: parseFloat(binancePosition.entryPrice?.toString() || '0'),
      markPrice: parseFloat(binancePosition.markPrice?.toString() || '0'),
      unrealizedPnl: parseFloat(binancePosition.unrealizedProfit?.toString() || '0'),
      marginType,
      leverage,
      contracts,
      contractSize: 1, // For USDT-M, contractSize is always 1
      realizedPnl: fundingFees, // Not available in position data, use getPositionRealizedPnl()
      liquidationPrice: parseFloat(binancePosition.liquidationPrice?.toString() || '0'),
      stopLossPrice: undefined,
      takeProfitPrice: undefined,
      exchangeId: this.id,
    };
  }

  /**
   * Get realized PnL for a symbol from income history
   * Note: This is a separate API call as position data doesn't include realized PnL
   */
  async getPositionRealizedPnl(symbol: string, limit: number = 100): Promise<number> {
    this.ensureConnected();

    try {
      const binanceSymbol = this.symbolToBinance(symbol);

      const income = await RetryUtils.retry(
        () =>
          this.client.getIncomeHistory({
            symbol: binanceSymbol,
            incomeType: 'REALIZED_PNL',
            limit,
          }),
        {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 1000,
        }
      );

      return income.reduce((sum, item) => sum + parseFloat(item.income?.toString() || '0'), 0);
    } catch (error) {
      this.logger.error(`Failed to get realized PnL for ${symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      return 0;
    }
  }

  // ==================== Trading Methods ====================

  private positionSideForOpen(side: OrderSide): 'LONG' | 'SHORT' | 'BOTH' {
    if (!this.isHedgeModeEnabled) return 'BOTH';
    return side === 'buy' ? 'LONG' : 'SHORT';
  }

  private positionSideForReduceOnly(side: OrderSide): 'LONG' | 'SHORT' | 'BOTH' {
    if (!this.isHedgeModeEnabled) return 'BOTH';
    return side === 'buy' ? 'SHORT' : 'LONG';
  }

  async createOrder(payload: CreateOrderPayload): Promise<IOrder> {
    return this.openPosition(payload);
  }

  async openPosition(payload: PositionOrderPayload): Promise<IOrder> {
    this.ensureConnected();

    try {
      const binanceSymbol = this.symbolToBinance(payload.symbol);
      this.logger.info(`Opening position for ${payload.symbol} (${binanceSymbol})`);

      // Apply precision to ensure amount meets exchange requirements
      const preciseAmount = this.amountToPrecision(payload.symbol, new Decimal(payload.amount));

      // Don't pass newClientOrderId - binance library will generate it with correct broker prefix
      const positionSide = this.positionSideForOpen(payload.side);
      this.logger.debug('Placing hedge-mode market order', {
        symbol: payload.symbol,
        side: payload.side,
        positionSide,
        quantity: preciseAmount.toNumber(),
        reduceOnly: !this.isHedgeModeEnabled ? false : undefined,
        hedgeMode: this.isHedgeModeEnabled,
      });
      const response = await RetryUtils.retry(
        () =>
          this.client.submitNewOrder({
            symbol: binanceSymbol,
            side: payload.side.toUpperCase() as 'BUY' | 'SELL',
            type: 'MARKET',
            quantity: preciseAmount.toNumber(),
            positionSide,
            ...(this.isHedgeModeEnabled ? {} : { reduceOnly: 'false' }),
          }),
        {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 1000,
        }
      );

      // Get clientOrderId from response - library generates it with correct broker prefix
      const clientOrderId = response.clientOrderId;

      return {
        id: clientOrderId, // Use clientOrderId from response as the primary ID
        clientOrderId: clientOrderId,
        symbol: payload.symbol,
        side: payload.side,
        type: 'market',
        price: 0,
        amount: preciseAmount.toNumber(),
        filled: parseFloat(response.executedQty?.toString() || '0'),
        remaining: preciseAmount.toNumber() - parseFloat(response.executedQty?.toString() || '0'),
        status: this.mapOrderStatus(response.status),
        timestamp: response.updateTime || Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to open position for ${payload.symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async closePosition(payload: PositionOrderPayload): Promise<IOrder> {
    this.ensureConnected();

    try {
      const binanceSymbol = this.symbolToBinance(payload.symbol);
      this.logger.info(`Closing position for ${payload.symbol} (${binanceSymbol})`);

      // Apply precision to ensure amount meets exchange requirements
      const preciseAmount = this.amountToPrecision(payload.symbol, new Decimal(payload.amount));

      // Don't pass newClientOrderId - binance library will generate it with correct broker prefix
      const positionSide = this.positionSideForReduceOnly(payload.side);
      this.logger.debug('Placing hedge-mode reduce-only market order', {
        symbol: payload.symbol,
        side: payload.side,
        positionSide,
        quantity: preciseAmount.toNumber(),
        reduceOnly: !this.isHedgeModeEnabled ? true : undefined,
        hedgeMode: this.isHedgeModeEnabled,
      });
      const response = await RetryUtils.retry(
        () =>
          this.client.submitNewOrder({
            symbol: binanceSymbol,
            side: payload.side.toUpperCase() as 'BUY' | 'SELL',
            type: 'MARKET',
            quantity: preciseAmount.toNumber(),
            positionSide,
            ...(this.isHedgeModeEnabled ? {} : { reduceOnly: 'true' }),
          }),
        {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 1000,
        }
      );

      // Get clientOrderId from response - library generates it with correct broker prefix
      const clientOrderId = response.clientOrderId;

      return {
        id: clientOrderId, // Use clientOrderId from response as the primary ID
        clientOrderId: clientOrderId,
        symbol: payload.symbol,
        side: payload.side,
        type: 'market',
        price: 0,
        amount: preciseAmount.toNumber(),
        filled: parseFloat(response.executedQty?.toString() || '0'),
        remaining: preciseAmount.toNumber() - parseFloat(response.executedQty?.toString() || '0'),
        status: this.mapOrderStatus(response.status),
        timestamp: response.updateTime || Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to close position for ${payload.symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  /**
   * Open position with limit order, ensuring execution (like market but cheaper).
   *
   * Uses aggressive limit pricing to get maker fees while guaranteeing fill.
   * For stat-arb where every basis point matters.
   *
   * Strategy:
   * 1. Place limit order at best bid/ask (aggressive, should fill immediately)
   * 2. If not filled, chase the price with updated limit orders
   * 3. After maxRetries, optionally fallback to market order
   *
   * @param payload - Order payload (symbol, side, amount)
   * @param options - Limit order options
   * @returns Filled order
   */
  async openPositionLimit(
    payload: PositionOrderPayload,
    options: {
      maxRetries?: number;
      retryIntervalMs?: number;
      fallbackToMarket?: boolean;
      maxSlippagePercent?: number;
      priceImprovementPercent?: number; // How much to improve price to get maker fee
    } = {}
  ): Promise<IOrder> {
    this.ensureConnected();

    const {
      maxRetries = 5,
      retryIntervalMs = 500,
      fallbackToMarket = true,
      maxSlippagePercent = 0.1,
      priceImprovementPercent = 0.01, // 0.01% improvement for maker fees
    } = options;

    const binanceSymbol = this.symbolToBinance(payload.symbol);
    const sideUpper = payload.side.toUpperCase() as 'BUY' | 'SELL';

    let currentOrderId: string | null = null;

    try {
      let preciseAmount = this.amountToPrecision(payload.symbol, new Decimal(payload.amount));

      // Get initial market data for price reference
      const initialMarketData = await this.getMarketData(payload.symbol);
      const initialPrice = sideUpper === 'BUY' ? initialMarketData.ask : initialMarketData.bid;

      this.logger.info(
        `Opening ${sideUpper} position for ${payload.symbol}: ${preciseAmount} (limit, initial_price=${initialPrice})`
      );

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Get current best price
        const marketData = await this.getMarketData(payload.symbol);
        let limitPrice: number;

        if (sideUpper === 'BUY') {
          // For BUY: use bid + small improvement to get maker fee while ensuring quick fill
          // This places us at the top of the bid queue
          limitPrice = marketData.bid * (1 + priceImprovementPercent / 100);
          // Ensure we don't exceed ask (would be taker)
          limitPrice = Math.min(limitPrice, marketData.ask * 0.9999);
        } else {
          // For SELL: use ask - small improvement to get maker fee while ensuring quick fill
          limitPrice = marketData.ask * (1 - priceImprovementPercent / 100);
          // Ensure we don't go below bid (would be taker)
          limitPrice = Math.max(limitPrice, marketData.bid * 1.0001);
        }

        // Check slippage only against worse prices (in our direction)
        const worstAcceptablePrice = sideUpper === 'BUY'
          ? initialPrice * (1 + maxSlippagePercent / 100)
          : initialPrice * (1 - maxSlippagePercent / 100);

        const slippageExceeded = sideUpper === 'BUY'
          ? limitPrice > worstAcceptablePrice
          : limitPrice < worstAcceptablePrice;

        if (slippageExceeded) {
          const priceChangePct = Math.abs(limitPrice - initialPrice) / initialPrice * 100;
          this.logger.warn(
            `Price moved unfavorably ${priceChangePct.toFixed(3)}% (max ${maxSlippagePercent}%), ` +
            `${fallbackToMarket ? 'falling back to market' : 'aborting'}`
          );

          if (fallbackToMarket) {
            return this.openPosition(payload);
          }
          throw new Error(`Price slippage exceeded ${maxSlippagePercent}%`);
        }

        const precisePrice = this.priceToPrecision(payload.symbol, new Decimal(limitPrice));

        // Cancel previous order if exists
        if (currentOrderId) {
          try {
            // Double-check status before canceling (might have filled)
            const lastCheck = await this.getOrder(currentOrderId, payload.symbol);
            if (lastCheck.status === 'closed') {
              this.logger.info(`Order ${currentOrderId} filled before cancellation`);
              return lastCheck;
            }
            await this.cancelOrder(currentOrderId, payload.symbol);
            this.logger.debug(`Cancelled stale order ${currentOrderId}`);
          } catch (err) {
            // Order might already be filled or cancelled
            this.logger.debug(`Could not cancel order ${currentOrderId}`, err as Error);
          }
        }

        try {
          const positionSide = this.positionSideForOpen(payload.side);
          
          // Don't pass newClientOrderId - binance library will generate it with correct broker prefix
          this.logger.debug('Placing hedge-mode limit order', {
            symbol: payload.symbol,
            side: sideUpper.toLowerCase(),
            positionSide,
            quantity: preciseAmount.toNumber(),
            price: parseFloat(precisePrice),
            hedgeMode: this.isHedgeModeEnabled,
          });
          // Place limit order with GTC (Good-Till-Cancel)
          const response = await this.client.submitNewOrder({
            symbol: binanceSymbol,
            side: sideUpper,
            type: 'LIMIT',
            quantity: preciseAmount.toNumber(),
            price: parseFloat(precisePrice),
            positionSide,
            timeInForce: 'GTC',
          });

          // Get clientOrderId from response - library generates it with correct broker prefix
          currentOrderId = response.clientOrderId; // Use clientOrderId from response for tracking

          this.logger.debug(
            `Placed limit order ${currentOrderId} at ${precisePrice} (attempt ${attempt + 1}/${maxRetries + 1})`
          );

          // Adaptive wait time: shorter on later attempts (price is moving)
          const adaptiveWaitTime = attempt === 0 ? retryIntervalMs : Math.max(200, retryIntervalMs - attempt * 50);
          await this.sleep(adaptiveWaitTime);

          // Check order status
          const updatedOrder = await this.getOrder(currentOrderId, payload.symbol);

          if (updatedOrder.status === 'closed') {
            this.logger.info(
              `✅ Limit order filled for ${payload.symbol}: ${preciseAmount} @ ${updatedOrder.price}`
            );
            return updatedOrder;
          }

          if (updatedOrder.filled > 0) {
            // Partially filled - calculate remaining
            const remaining = preciseAmount.toNumber() - updatedOrder.filled;
            if (remaining <= 0) {
              // Fully filled between placement and check
              this.logger.info(
                `✅ Limit order fully filled for ${payload.symbol}: ${updatedOrder.filled} @ ${updatedOrder.price}`
              );
              return updatedOrder;
            }

            this.logger.info(
              `Partial fill: ${updatedOrder.filled}/${preciseAmount}, continuing with ${remaining}`
            );
            preciseAmount = this.amountToPrecision(payload.symbol, new Decimal(remaining));
          }
        } catch (error) {
          const errorCode = get(error, 'code');
          this.logger.error(`Order attempt failed`, error as Error, { code: errorCode });

          // Error -2021: Order would immediately match and take - this is fine for our purpose
          if (errorCode !== -2021) {
            throw error;
          }
        }
      }

      // Exhausted retries - cancel any pending order and fallback
      if (currentOrderId) {
        try {
          await this.cancelOrder(currentOrderId, payload.symbol);
        } catch {
          // Ignore
        }
      }

      if (fallbackToMarket) {
        this.logger.warn(
          `Limit order not filled after ${maxRetries + 1} attempts, falling back to market order`
        );
        return this.openPosition(payload);
      }

      throw new Error(`Limit order for ${payload.symbol} not filled after ${maxRetries + 1} attempts`);
    } catch (error) {
      // Cancel any pending order on error
      if (currentOrderId) {
        try {
          await this.cancelOrder(currentOrderId, payload.symbol);
        } catch {
          // Ignore
        }
      }

      this.logger.error(`Failed to open limit position for ${payload.symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  /**
   * Close position with limit order, ensuring execution (like market but cheaper).
   *
   * Uses aggressive limit pricing to get maker fees while guaranteeing fill.
   *
   * @param payload - Order payload (symbol, side, amount)
   * @param options - Limit order options
   * @returns Filled order
   */
  async closePositionLimit(
    payload: PositionOrderPayload,
    options: {
      maxRetries?: number;
      retryIntervalMs?: number;
      fallbackToMarket?: boolean;
      maxSlippagePercent?: number;
      priceImprovementPercent?: number;
    } = {}
  ): Promise<IOrder> {
    this.ensureConnected();

    const {
      maxRetries = 5,
      retryIntervalMs = 500,
      fallbackToMarket = true,
      maxSlippagePercent = 0.1,
      priceImprovementPercent = 0.01,
    } = options;

    const binanceSymbol = this.symbolToBinance(payload.symbol);
    const sideUpper = payload.side.toUpperCase() as 'BUY' | 'SELL';

    let currentOrderId: string | null = null;

    try {
      let preciseAmount = this.amountToPrecision(payload.symbol, new Decimal(payload.amount));

      // Get initial market data for price reference
      const initialMarketData = await this.getMarketData(payload.symbol);
      const initialPrice = sideUpper === 'BUY' ? initialMarketData.ask : initialMarketData.bid;

      this.logger.info(
        `Closing position for ${payload.symbol}: ${sideUpper} ${preciseAmount} (limit, initial_price=${initialPrice})`
      );

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Get current best price
        const marketData = await this.getMarketData(payload.symbol);
        let limitPrice: number;

        if (sideUpper === 'BUY') {
          // For closing SHORT (BUY to close): bid + improvement
          limitPrice = marketData.bid * (1 + priceImprovementPercent / 100);
          limitPrice = Math.min(limitPrice, marketData.ask * 0.9999);
        } else {
          // For closing LONG (SELL to close): ask - improvement
          limitPrice = marketData.ask * (1 - priceImprovementPercent / 100);
          limitPrice = Math.max(limitPrice, marketData.bid * 1.0001);
        }

        // Check slippage only against worse prices
        const worstAcceptablePrice = sideUpper === 'BUY'
          ? initialPrice * (1 + maxSlippagePercent / 100)
          : initialPrice * (1 - maxSlippagePercent / 100);

        const slippageExceeded = sideUpper === 'BUY'
          ? limitPrice > worstAcceptablePrice
          : limitPrice < worstAcceptablePrice;

        if (slippageExceeded) {
          const priceChangePct = Math.abs(limitPrice - initialPrice) / initialPrice * 100;
          this.logger.warn(
            `Price moved unfavorably ${priceChangePct.toFixed(3)}% (max ${maxSlippagePercent}%), ` +
            `${fallbackToMarket ? 'falling back to market' : 'aborting'}`
          );

          if (fallbackToMarket) {
            return this.closePosition(payload);
          }
          throw new Error(`Price slippage exceeded ${maxSlippagePercent}%`);
        }

        const precisePrice = this.priceToPrecision(payload.symbol, new Decimal(limitPrice));

        // Cancel previous order if exists
        if (currentOrderId) {
          try {
            // Double-check status before canceling
            const lastCheck = await this.getOrder(currentOrderId, payload.symbol);
            if (lastCheck.status === 'closed') {
              this.logger.info(`Close order ${currentOrderId} filled before cancellation`);
              return lastCheck;
            }
            await this.cancelOrder(currentOrderId, payload.symbol);
          } catch (err) {
            this.logger.debug(`Could not cancel close order ${currentOrderId}`, err as Error);
          }
        }

        try {
          const positionSide = this.positionSideForReduceOnly(payload.side);
          
          // Don't pass newClientOrderId - binance library will generate it with correct broker prefix
          this.logger.debug('Placing hedge-mode close limit order', {
            symbol: payload.symbol,
            side: sideUpper.toLowerCase(),
            positionSide,
            quantity: preciseAmount.toNumber(),
            price: parseFloat(precisePrice),
            reduceOnly: !this.isHedgeModeEnabled ? true : undefined,
            hedgeMode: this.isHedgeModeEnabled,
          });
          // Place limit order with reduceOnly
          const response = await this.client.submitNewOrder({
            symbol: binanceSymbol,
            side: sideUpper,
            type: 'LIMIT',
            quantity: preciseAmount.toNumber(),
            price: parseFloat(precisePrice),
            positionSide,
            timeInForce: 'GTC',
            ...(this.isHedgeModeEnabled ? {} : { reduceOnly: 'true' }),
          });

          // Get clientOrderId from response - library generates it with correct broker prefix
          currentOrderId = response.clientOrderId; // Use clientOrderId from response for tracking

          this.logger.debug(
            `Placed close limit order ${currentOrderId} at ${precisePrice} (attempt ${attempt + 1}/${maxRetries + 1})`
          );

          // Adaptive wait time
          const adaptiveWaitTime = attempt === 0 ? retryIntervalMs : Math.max(200, retryIntervalMs - attempt * 50);
          await this.sleep(adaptiveWaitTime);

          const updatedOrder = await this.getOrder(currentOrderId, payload.symbol);

          if (updatedOrder.status === 'closed') {
            this.logger.info(
              `✅ Close limit order filled for ${payload.symbol}: ${preciseAmount} @ ${updatedOrder.price}`
            );
            return updatedOrder;
          }

          if (updatedOrder.filled > 0) {
            const remaining = preciseAmount.toNumber() - updatedOrder.filled;
            if (remaining <= 0) {
              this.logger.info(
                `✅ Close limit order fully filled for ${payload.symbol}: ${updatedOrder.filled} @ ${updatedOrder.price}`
              );
              return updatedOrder;
            }
            preciseAmount = this.amountToPrecision(payload.symbol, new Decimal(remaining));
          }
        } catch (error) {
          const errorCode = get(error, 'code');
          this.logger.error(`Close order attempt failed`, error as Error, { code: errorCode });

          if (errorCode !== -2021) {
            throw error;
          }
        }
      }

      // Exhausted retries
      if (currentOrderId) {
        try {
          await this.cancelOrder(currentOrderId, payload.symbol);
        } catch {
          // Ignore
        }
      }

      if (fallbackToMarket) {
        this.logger.warn(
          `Close limit order not filled after ${maxRetries + 1} attempts, falling back to market order`
        );
        return this.closePosition(payload);
      }

      throw new Error(`Close limit order for ${payload.symbol} not filled after ${maxRetries + 1} attempts`);
    } catch (error) {
      if (currentOrderId) {
        try {
          await this.cancelOrder(currentOrderId, payload.symbol);
        } catch {
          // Ignore
        }
      }

      this.logger.error(`Failed to close limit position for ${payload.symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  /**
   * Flash close position using limit order with fallback to market
   */
  async flashClosePositionLimit(
    symbol: string,
    options: {
      maxRetries?: number;
      retryIntervalMs?: number;
      fallbackToMarket?: boolean;
      maxSlippagePercent?: number;
    } = {}
  ): Promise<IOrder> {
    this.ensureConnected();

    try {
      const positions = await this.getPositions({ symbol });

      if (positions.length === 0 || !positions[0]!.contracts || positions[0]!.contracts === 0) {
        throw new NoPositionFound(this.id, symbol);
      }

      const position = positions[0]!;
      const closeSide = position.side === 'long' ? 'sell' : 'buy';

      const order = await this.closePositionLimit(
        {
          symbol,
          side: closeSide,
          amount: position.contracts!,
        },
        options
      );

      // Cancel all open orders after closing position
      await this.cancelAllOrders(symbol);

      return order;
    } catch (error) {
      this.logger.error(
        `Failed to flash close position (limit) for ${symbol} on ${this.id}`,
        error as Error,
        {
          body: get(error, 'code'),
          code: get(error, 'body.message'),
        }
      );
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async flashClosePosition(symbol: string): Promise<IOrder> {
    this.ensureConnected();

    try {
      const positions = await this.getPositions({ symbol });

      if (positions.length === 0 || !positions[0]!.contracts || positions[0]!.contracts === 0) {
        throw new NoPositionFound(this.id, symbol);
      }

      const position = positions[0]!;
      const closeSide = position.side === 'long' ? 'sell' : 'buy';

      const order = await this.closePosition({
        symbol,
        side: closeSide,
        amount: position.contracts!,
      });

      // Cancel all open orders after closing position
      await this.cancelAllOrders(symbol);

      return order;
    } catch (error) {
      this.logger.error(
        `Failed to flash close position for ${symbol} on ${this.id}`,
        error as Error,
        {
          body: get(error, 'code'),
          code: get(error, 'body.message'),
        }
      );
      throw error;
    }
  }

  private async cancelAllOrders(symbol: string): Promise<void> {
    try {
      const binanceSymbol = this.symbolToBinance(symbol);
      await RetryUtils.retry(() => this.client.cancelAllOpenOrders({ symbol: binanceSymbol }), {
        maxRetries: 2,
        baseDelay: 500,
        maxDelay: 1000,
      });
    } catch (error) {
      this.logger.error(`Failed to cancel all orders for ${symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async setStopLoss(params: {
    symbol: string;
    side: OrderSide;
    amount?: number;
    stopLossPrice: Decimal;
  }): Promise<IOrder> {
    const { symbol, side, stopLossPrice } = params;
    this.ensureConnected();

    const closeSide: OrderSide = side === 'buy' ? 'sell' : 'buy';
    const binanceSymbol = this.symbolToBinance(symbol);

    try {
      // Format price to meet exchange precision requirements
      const preciseStopPrice = parseFloat(this.priceToPrecision(symbol, stopLossPrice));

      // Always use closePosition=true to close entire position
      // When closePosition=true, quantity should not be specified
      const positionSide = this.positionSideForOpen(side);
      this.logger.debug('Placing hedge-mode stop-loss order', {
        symbol,
        side: closeSide,
        positionSide,
        stopPrice: preciseStopPrice,
        closePosition: true,
        hedgeMode: this.isHedgeModeEnabled,
      });
      const slOrder = await RetryUtils.retry(
        () =>
          this.client.submitNewOrder({
            symbol: binanceSymbol,
            side: closeSide.toUpperCase() as 'BUY' | 'SELL',
            type: 'STOP_MARKET',
            stopPrice: preciseStopPrice,
            closePosition: 'true', // Always close entire position
            positionSide,
            workingType: 'MARK_PRICE',
          }),
        {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 1000,
        }
      );

      this.logger.info(
        `✅ Stop Loss order created for ${symbol} at ${preciseStopPrice} (closes entire position)`
      );

      return {
        // Use clientOrderId as primary ID to avoid precision loss with large orderId values
        id: slOrder.clientOrderId || slOrder.orderId?.toString() || '',
        clientOrderId: slOrder.clientOrderId,
        symbol,
        side: closeSide,
        type: 'stop_market',
        price: preciseStopPrice,
        amount: 0, // closePosition=true closes entire position, amount is not used
        filled: 0,
        remaining: 0,
        status: this.mapOrderStatus(slOrder.status),
        timestamp: slOrder.updateTime || Date.now(),
      };
    } catch (error) {
      this.logger.error(`❌ Failed to create Stop Loss order for ${symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async setTakeProfit(params: {
    symbol: string;
    side: OrderSide;
    amount?: number;
    takeProfitPrice: Decimal;
  }): Promise<IOrder> {
    const { symbol, side, takeProfitPrice } = params;
    this.ensureConnected();

    const closeSide: OrderSide = side === 'buy' ? 'sell' : 'buy';
    const binanceSymbol = this.symbolToBinance(symbol);

    try {
      // Format price to meet exchange precision requirements
      const preciseTakeProfitPrice = parseFloat(this.priceToPrecision(symbol, takeProfitPrice));

      // Always use closePosition=true to close entire position
      // When closePosition=true, quantity should not be specified
      const positionSide = this.positionSideForOpen(side);
      this.logger.debug('Placing hedge-mode take-profit order', {
        symbol,
        side: closeSide,
        positionSide,
        stopPrice: preciseTakeProfitPrice,
        closePosition: true,
        hedgeMode: this.isHedgeModeEnabled,
      });
      const tpOrder = await RetryUtils.retry(
        () =>
          this.client.submitNewOrder({
            symbol: binanceSymbol,
            side: closeSide.toUpperCase() as 'BUY' | 'SELL',
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: preciseTakeProfitPrice,
            closePosition: 'true', // Always close entire position
            positionSide,
            workingType: 'MARK_PRICE',
          }),
        {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 1000,
        }
      );

      this.logger.info(
        `✅ Take Profit order created for ${symbol} at ${preciseTakeProfitPrice} (closes entire position)`
      );

      return {
        // Use clientOrderId as primary ID to avoid precision loss with large orderId values
        id: tpOrder.clientOrderId || tpOrder.orderId?.toString() || '',
        clientOrderId: tpOrder.clientOrderId,
        symbol,
        side: closeSide,
        type: 'take_profit_market',
        price: preciseTakeProfitPrice,
        amount: 0, // closePosition=true closes entire position, amount is not used
        filled: 0,
        remaining: 0,
        status: this.mapOrderStatus(tpOrder.status),
        timestamp: tpOrder.updateTime || Date.now(),
      };
    } catch (error) {
      this.logger.error(`❌ Failed to create Take Profit order for ${symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async setStopLossAndTakeProfit(params: {
    symbol: string;
    side: OrderSide;
    amount: number;
    stopLossPrice: Decimal;
    takeProfitPrice: Decimal;
  }): Promise<{ slOrder: IOrder; tpOrder: IOrder }> {
    // Note: amount parameter is ignored - TP/SL always close entire position
    const [slOrder, tpOrder] = await Promise.all([
      this.setStopLoss({
        symbol: params.symbol,
        side: params.side,
        stopLossPrice: params.stopLossPrice,
      }),
      this.setTakeProfit({
        symbol: params.symbol,
        side: params.side,
        takeProfitPrice: params.takeProfitPrice,
      }),
    ]);

    return { slOrder, tpOrder };
  }

  /**
   * Cancel an order by client order ID (preferred) or Binance order ID.
   * Using clientOrderId is recommended to avoid precision loss with large orderId values.
   * 
   * @param orderIdOrClientId - Either a clientOrderId (string starting with prefix like 'open_', 'close_') 
   *                           or a Binance orderId (numeric string)
   * @param symbol - Trading pair symbol
   */
  async cancelOrder(orderIdOrClientId: string, symbol: string): Promise<void> {
    this.ensureConnected();

    try {
      const binanceSymbol = this.symbolToBinance(symbol);
      const isClientOrderId = this.isClientOrderId(orderIdOrClientId);
      
      const params: any = { symbol: binanceSymbol };
      if (isClientOrderId) {
        params.origClientOrderId = orderIdOrClientId;
      } else {
        // Legacy: pass as string to avoid precision loss
        params.orderId = orderIdOrClientId;
      }
      
      await RetryUtils.retry(() => this.client.cancelOrder(params), {
        maxRetries: 2,
        baseDelay: 500,
        maxDelay: 1000,
      });
    } catch (error) {
      this.logger.error(`Failed to cancel order ${orderIdOrClientId}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  /**
   * Get order status by client order ID (preferred) or Binance order ID.
   * Using clientOrderId is recommended to avoid precision loss with large orderId values.
   * 
   * @param orderIdOrClientId - Either a clientOrderId or a Binance orderId
   * @param symbol - Trading pair symbol
   */
  async getOrder(orderIdOrClientId: string, symbol: string): Promise<IOrder> {
    this.ensureConnected();

    try {
      const binanceSymbol = this.symbolToBinance(symbol);
      const isClientOrderId = this.isClientOrderId(orderIdOrClientId);
      
      const params: any = { symbol: binanceSymbol };
      if (isClientOrderId) {
        params.origClientOrderId = orderIdOrClientId;
      } else {
        // Legacy: pass as string to avoid precision loss
        params.orderId = orderIdOrClientId;
      }
      
      const order = await RetryUtils.retry(() => this.client.getOrder(params), {
        maxRetries: 2,
        baseDelay: 500,
        maxDelay: 1000,
      });

      // Use clientOrderId as primary ID to avoid precision loss with large orderId values
      const primaryId = order.clientOrderId || order.orderId?.toString() || orderIdOrClientId;
      
      return {
        id: primaryId,
        clientOrderId: order.clientOrderId,
        symbol: this.symbolFromBinance(order.symbol),
        side: order.side.toLowerCase() as OrderSide,
        type: order.type.toLowerCase(),
        price: parseFloat(order.price?.toString() || '0'),
        amount: parseFloat(order.origQty?.toString() || '0'),
        filled: parseFloat(order.executedQty?.toString() || '0'),
        remaining:
          parseFloat(order.origQty?.toString() || '0') -
          parseFloat(order.executedQty?.toString() || '0'),
        status: this.mapOrderStatus(order.status),
        timestamp: order.updateTime || order.time || Date.now(),
      };
    } catch (error) {
      this.logger.error(`Failed to get order ${orderIdOrClientId}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async getOrders(symbol?: string): Promise<IOrder[]> {
    this.ensureConnected();

    try {
      const params: any = {};
      if (symbol) {
        params.symbol = this.symbolToBinance(symbol);
      }

      const orders = await RetryUtils.retry(() => this.client.getAllOpenOrders(params), {
        maxRetries: 2,
        baseDelay: 500,
        maxDelay: 1000,
      });

      return orders.map((order: any) => ({
        // Use clientOrderId as primary ID to avoid precision loss with large orderId values
        id: order.clientOrderId || order.orderId?.toString() || '',
        clientOrderId: order.clientOrderId,
        symbol: this.symbolFromBinance(order.symbol),
        side: order.side.toLowerCase() as OrderSide,
        type: order.type.toLowerCase(),
        price: parseFloat(order.price?.toString() || '0'),
        amount: parseFloat(order.origQty?.toString() || '0'),
        filled: parseFloat(order.executedQty?.toString() || '0'),
        remaining:
          parseFloat(order.origQty?.toString() || '0') -
          parseFloat(order.executedQty?.toString() || '0'),
        status: this.mapOrderStatus(order.status),
        timestamp: order.updateTime || order.time || Date.now(),
      }));
    } catch (error) {
      this.logger.error(`Failed to get orders`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async getTrades(symbol?: string, limit: number = 100): Promise<Trade[]> {
    this.ensureConnected();

    try {
      if (!symbol) {
        throw new Error('Symbol is required for getTrades');
      }

      const binanceSymbol = this.symbolToBinance(symbol);
      const trades = await RetryUtils.retry(
        () =>
          this.client.getRecentTrades({
            symbol: binanceSymbol,
            limit,
          }),
        {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 1000,
        }
      );

      return trades.map((trade: any) => ({
        id: trade.id.toString(),
        symbol: this.symbolFromBinance(binanceSymbol),
        side: trade.isBuyerMaker ? 'sell' : 'buy',
        price: parseFloat(trade.price.toString()),
        amount: parseFloat(trade.qty.toString()),
        cost: parseFloat(trade.quoteQty?.toString() || '0'),
        fee: {
          currency: 'USDT',
          cost: 0,
        },
        timestamp: trade.time,
        exchangeId: this.id,
      }));
    } catch (error) {
      this.logger.error(`Failed to get trades for ${symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  private mapOrderStatus(status: string): 'open' | 'closed' | 'canceled' {
    const statusMap: Record<string, 'open' | 'closed' | 'canceled'> = {
      NEW: 'open',
      PARTIALLY_FILLED: 'open',
      FILLED: 'closed',
      CANCELED: 'canceled',
      PENDING_CANCEL: 'open',
      REJECTED: 'canceled',
      EXPIRED: 'canceled',
    };

    return statusMap[status] || 'open';
  }

  // ==================== Margin Methods ====================

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.ensureConnected();

    try {
      const binanceSymbol = this.symbolToBinance(symbol);
      await RetryUtils.retry(
        () =>
          this.client.setLeverage({
            symbol: binanceSymbol,
            leverage,
          }),
        {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 1000,
        }
      );

      this.logger.info(`Set leverage to ${leverage}x for ${symbol} on ${this.name}`);
    } catch (error) {
      this.logger.error(`Failed to set leverage for ${symbol} on ${this.name}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async setMarginMode(symbol: string, mode: 'isolated' | 'cross'): Promise<void> {
    this.ensureConnected();

    try {
      const binanceSymbol = this.symbolToBinance(symbol);
      await RetryUtils.retry(
        () =>
          this.client.setMarginType({
            symbol: binanceSymbol,
            marginType: mode === 'isolated' ? 'ISOLATED' : 'CROSSED',
          }),
        {
          maxRetries: 2,
          baseDelay: 500,
          maxDelay: 1000,
        }
      );

      this.logger.info(`Set margin mode to ${mode} for ${symbol} on ${this.name}`);
    } catch (error) {
      if (get(error, 'code') === -4046) {
        this.logger.debug(`Margin mode for ${symbol} on ${this.name} is already set to ${mode}`);
        return;
      }
      this.logger.error(`Failed to set margin mode for ${symbol} on ${this.name}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  // ==================== Utility Methods ====================

  async getSymbols(): Promise<string[]> {
    this.ensureConnected();
    return Array.from(this.marketsCache.keys());
  }

  async validateSymbol(symbol: string): Promise<boolean> {
    this.ensureConnected();
    return this.marketsCache.has(symbol);
  }

  async getMinOrderSize(symbol: string): Promise<number> {
    this.ensureConnected();

    const market = this.marketsCache.get(symbol);
    if (!market) {
      throw new Error(`Market not found for ${symbol}`);
    }

    const lotSizeFilter = market.filters.find((f: any) => f.filterType === 'LOT_SIZE') as any;

    if (lotSizeFilter && lotSizeFilter.minQty) {
      return parseFloat(lotSizeFilter.minQty.toString());
    }

    return 0;
  }

  async getMaxOrderSize(symbol: string): Promise<number> {
    this.ensureConnected();

    const market = this.marketsCache.get(symbol);
    if (!market) {
      throw new Error(`Market not found for ${symbol}`);
    }

    const lotSizeFilter = market.filters.find((f: any) => f.filterType === 'LOT_SIZE') as any;

    if (lotSizeFilter && lotSizeFilter.maxQty) {
      return parseFloat(lotSizeFilter.maxQty.toString());
    }

    return 1000000; // Very large number if not specified
  }

  async ping(): Promise<boolean> {
    try {
      await RetryUtils.retry(() => this.client.testConnectivity(), {
        maxRetries: 2,
        baseDelay: 500,
        maxDelay: 1000,
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  async getServerTime(): Promise<number> {
    try {
      return await RetryUtils.retry(() => this.client.getServerTime(), {
        maxRetries: 2,
        baseDelay: 500,
        maxDelay: 1000,
      });
    } catch (error) {
      this.logger.error('Failed to get server time', error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  // ==================== Calculation Methods ====================

  async calculateAmountFromUSDT(symbol: string, usdtAmount: number): Promise<Decimal> {
    const price = await this.getCurrentPrice(symbol);
    return new Decimal(usdtAmount).div(price);
  }

  async calculateUSDTFromAmount(symbol: string, amount: number): Promise<Decimal> {
    const price = await this.getCurrentPrice(symbol);
    return new Decimal(amount).mul(price);
  }

  amountToPrecision(symbol: string, amount: Decimal | number): Decimal {
    this.ensureConnected();

    const market = this.marketsCache.get(symbol);
    if (!market) {
      return new Decimal(amount);
    }

    // Find LOT_SIZE filter
    const lotSizeFilter = market.filters.find((f: any) => f.filterType === 'LOT_SIZE') as any;

    if (!lotSizeFilter) {
      return new Decimal(amount);
    }

    const stepSize = parseFloat(lotSizeFilter.stepSize?.toString() || '1');
    const minQty = parseFloat(lotSizeFilter.minQty?.toString() || '0');

    let result = new Decimal(amount).toDecimalPlaces(8, Decimal.ROUND_DOWN);

    // Round to step size
    result = result.div(stepSize).floor().mul(stepSize);

    // Ensure we meet minimum size
    if (minQty > 0 && result.lessThan(minQty)) {
      result = new Decimal(minQty);
    }

    return result;
  }

  priceToPrecision(symbol: string, price: number | string | Decimal): string {
    this.ensureConnected();

    const market = this.marketsCache.get(symbol);
    if (!market) {
      // Fallback to 4 decimal places
      return new Decimal(price).toFixed(4);
    }

    // Find PRICE_FILTER
    const priceFilter = market.filters.find((f: any) => f.filterType === 'PRICE_FILTER') as any;

    if (!priceFilter) {
      // Fallback to pricePrecision from market
      const precision = market.pricePrecision || 4;
      return new Decimal(price).toFixed(precision);
    }

    const tickSize = parseFloat(priceFilter.tickSize?.toString() || '0.01');
    const pricePrecision = market.pricePrecision || 4;

    // Round to tick size
    let rounded = new Decimal(price).div(tickSize).floor().mul(tickSize);

    // Apply price precision (limit decimal places)
    return rounded.toFixed(pricePrecision);
  }

  async calculateAmountFromUSDTPrecised(
    symbol: string,
    targetUsdtAmount: number,
    midPrice?: Decimal
  ): Promise<Decimal> {
    const price = midPrice || (await this.getCurrentPrice(symbol));
    const amount = new Decimal(targetUsdtAmount).div(price);
    return this.amountToPrecision(symbol, amount);
  }

  async calculateCoinsFromContracts(symbol: string, contracts: Decimal): Promise<Decimal> {
    // For Binance USDT-M futures, contractSize is always 1
    // So contracts = coins
    return contracts;
  }

  async calculateContractsFromCoins(symbol: string, coins: Decimal): Promise<Decimal> {
    this.ensureConnected();

    // For Binance USDT-M futures, contractSize is always 1
    // So contracts = coins, but we need to apply precision (stepSize and minQty)
    return this.amountToPrecision(symbol, coins);
  }

  // ==================== WebSocket Methods ====================

  private getOrCreateWsClient(): WebsocketClient {
    if (!this.wsClient) {
      this.wsClient = new WebsocketClient({
        beautify: false,
      });

      // Setup reconnection handlers
      this.wsClient.on('open', (data: any) => {
        this.logger.info('Binance WebSocket opened', { wsKey: data?.wsKey });
      });

      this.wsClient.on('reconnecting', (data: any) => {
        this.logger.warn('Binance WebSocket reconnecting', { wsKey: data?.wsKey });
        // Resubscribe to all active subscriptions
        this.resubscribeAll();
      });

      this.wsClient.on('reconnected', (data: any) => {
        this.logger.info('Binance WebSocket reconnected', { wsKey: data?.wsKey });
      });

      this.wsClient.on('message', (data: any) => {
        this.handleWsMessage(data);
      });

      this.wsClient.on('response', (data: any) => {
        this.logger.debug('Binance WebSocket response', data);
      });

      this.wsClient.on('exception', (data: any) => {
        this.logger.error('Binance WebSocket exception', new Error(JSON.stringify(data)), {
          body: get(data, 'code'),
          code: get(data, 'body.message'),
        });
      });
    }

    return this.wsClient;
  }

  private handleWsMessage(data: any): void {
    try {
      // Check if this is book ticker data
      if (data && data.e === 'bookTicker') {
        const bookTicker = data as BinanceBookTickerData;
        const binanceSymbol = bookTicker.s;

        // Find callback for this symbol
        const callback = this.wsCallbacks.get(binanceSymbol);
        if (callback) {
          const symbol = this.symbolFromBinance(binanceSymbol);
          const ticker: MarketData = {
            symbol,
            timestamp: bookTicker.E,
            bid: parseFloat(bookTicker.b),
            ask: parseFloat(bookTicker.a),
            last: parseFloat(bookTicker.b),
            exchangeId: this.id,
          };

          callback(ticker);
        }
      }
    } catch (error) {
      this.logger.error('Error processing WebSocket message', error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
    }
  }

  private async resubscribeAll(): Promise<void> {
    // Resubscribe to all active subscriptions after reconnection
    for (const binanceSymbol of this.wsActiveSubscriptions) {
      try {
        const topic = `${binanceSymbol.toLowerCase()}@bookTicker`;
        await this.wsClient!.subscribe([topic], 'usdm');
      } catch (error) {
        this.logger.error(`Failed to resubscribe to ${binanceSymbol}`, error as Error, {
          body: get(error, 'code'),
          code: get(error, 'body.message'),
        });
      }
    }
  }

  async subscribeToTicker(symbol: string, callback: TickerCallback): Promise<void> {
    try {
      const wsClient = this.getOrCreateWsClient();
      const binanceSymbol = this.symbolToBinance(symbol);

      // Check if already subscribed
      if (this.wsActiveSubscriptions.has(binanceSymbol)) {
        this.logger.debug(`Already subscribed to ${symbol} on ${this.id}`);
        return;
      }

      const topic = `${binanceSymbol.toLowerCase()}@bookTicker`;

      this.logger.info(`Subscribing to ticker for ${symbol} (${binanceSymbol})`);

      await wsClient.subscribe([topic], 'usdm');

      this.wsCallbacks.set(binanceSymbol, callback);
      this.wsActiveSubscriptions.add(binanceSymbol);

      this.logger.info(`Subscribed to ticker for ${symbol} (${binanceSymbol})`);
    } catch (error) {
      this.logger.error(`Failed to subscribe to ticker for ${symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
      throw error;
    }
  }

  async unsubscribeFromTicker(symbol: string): Promise<void> {
    try {
      const binanceSymbol = this.symbolToBinance(symbol);

      if (!this.wsActiveSubscriptions.has(binanceSymbol)) {
        this.logger.debug(`Not subscribed to ${symbol} on ${this.id}`);
        return;
      }

      const topic = `${binanceSymbol.toLowerCase()}@bookTicker`;

      this.logger.info(`Unsubscribing from ticker for ${symbol} (${binanceSymbol})`);

      if (this.wsClient) {
        await this.wsClient.unsubscribe([topic], 'usdm');
      }

      this.wsCallbacks.delete(binanceSymbol);
      this.wsActiveSubscriptions.delete(binanceSymbol);

      this.logger.info(`Unsubscribed from ticker for ${symbol}`);
    } catch (error) {
      this.logger.error(`Failed to unsubscribe from ticker for ${symbol}`, error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
    }
  }

  async subscribeToMultipleTickers(symbols: string[], callback: TickerCallback): Promise<void> {
    await Promise.all(symbols.map(symbol => this.subscribeToTicker(symbol, callback)));
  }

  async unsubscribeFromAllTickers(): Promise<void> {
    try {
      // Unsubscribe from all topics
      for (const binanceSymbol of this.wsActiveSubscriptions) {
        const topic = `${binanceSymbol.toLowerCase()}@bookTicker`;

        if (this.wsClient) {
          await this.wsClient.unsubscribe([topic], 'usdm');
        }
      }

      // Close WebSocket client
      if (this.wsClient) {
        this.wsClient.closeAll();
        this.wsClient = null;
      }

      // Clear all subscriptions
      this.wsCallbacks.clear();
      this.wsActiveSubscriptions.clear();

      this.logger.info('Unsubscribed from all tickers');
    } catch (error) {
      this.logger.error('Failed to unsubscribe from all tickers', error as Error, {
        body: get(error, 'code'),
        code: get(error, 'body.message'),
      });
    }
  }
}
