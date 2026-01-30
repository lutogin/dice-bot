import Decimal from 'decimal.js';
import {
  FundingRateData,
  MarketData,
  OrderBookData,
  Balance,
  Trade,
  OrderSide,
  OrderType,
  IPosition,
  IOrder,
} from './exchange.types';

export type TickerCallback = (ticker: MarketData) => void;

export type TradeSide = 'open' | 'close';

export interface WebSocketSubscription {
  symbol: string;
  callback: TickerCallback;
  active: boolean;
  interval?: NodeJS.Timeout; // для polling fallback
  ws?: any; // для нативного WebSocket (Binance)
  reconnectAttempts?: number; // для отслеживания попыток переподключения
}

export interface CreateOrderPayload {
  symbol: string;
  type: OrderType;
  side: OrderSide;
  amount: number;
  price?: number;
  leverage?: number;
  params?: Record<string, any>; // Additional exchange-specific parameters
}

export interface PositionOrderPayload {
  symbol: string;
  side: OrderSide;
  amount: number;
  leverage?: number;
}

export interface CreateMarketOrderPayload extends PositionOrderPayload {
  params?: {
    tradeSide?: TradeSide;
    [key: string]: any;
  };
}

export interface CreateMarketOrderUSDTPayload {
  symbol: string;
  side: OrderSide;
  usdtAmount: number;
  params?: any;
}

export interface IExchangeClient {
  readonly id: string;
  readonly name: string;
  readonly isEnabled: boolean;
  readonly isTestnet: boolean;
  readonly takerFee: Decimal;
  readonly makerFee: Decimal;

  // Connection methods
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  loadMarkets(): Promise<void>;

  // WebSocket methods
  subscribeToTicker(symbol: string, callback: TickerCallback): Promise<void>;
  unsubscribeFromTicker(symbol: string): Promise<void>;
  subscribeToMultipleTickers(symbols: string[], callback: TickerCallback): Promise<void>;
  unsubscribeFromAllTickers(): Promise<void>;
  isWebSocketConnected(): boolean;

  // Market data methods
  getFundingRates(symbols?: string[]): Promise<FundingRateData[]>;
  getFundingRate(symbol: string): Promise<FundingRateData>;
  getMarketData(symbol: string): Promise<MarketData>;
  getOrderBook(symbol: string, limit?: number): Promise<OrderBookData>;
  getCurrentPrice(symbol: string): Promise<Decimal>;

  // Account methods
  getBalances(): Promise<Balance[]>;
  getBalance(
    asset: string, // USDT by default
    options: {
      type?: 'spot' | 'future' | 'swap' | 'margin';
      code?: string;
    }
  ): Promise<Balance>;
  /**
   * @param asset - Asset symbol (default: 'USDT')
   * @returns Balance object with free, used, and total amounts
   */
  getFuturesBalance(asset?: string): Promise<Balance>;

  getPosition(params?: { symbol: string; skipZeroPositions?: boolean }): Promise<IPosition | null>;
  getPositions(params?: { symbol?: string; skipZeroPositions?: boolean }): Promise<IPosition[]>;

  // Trading methods
  createOrder(payload: CreateOrderPayload): Promise<IOrder>;
  // createMarketOrder(payload: CreateMarketOrderPayload): Promise<Order>;
  openPosition(payload: PositionOrderPayload): Promise<IOrder>;
  closePosition(payload: PositionOrderPayload): Promise<IOrder>;
  flashClosePosition(symbol: string): Promise<IOrder>;
  setStopLoss(params: {
    symbol: string;
    side: OrderSide;
    amount?: number; // Optional: if not provided, closes entire position
    stopLossPrice: Decimal;
  }): Promise<IOrder>;
  setTakeProfit(params: {
    symbol: string;
    side: OrderSide;
    amount?: number; // Optional: if not provided, closes entire position
    takeProfitPrice: Decimal;
  }): Promise<IOrder>;
  setStopLossAndTakeProfit(params: {
    symbol: string;
    side: OrderSide;
    amount: number;
    stopLossPrice: Decimal;
    takeProfitPrice: Decimal;
  }): Promise<{ slOrder: IOrder; tpOrder: IOrder }>;

  cancelOrder(orderId: string, symbol: string): Promise<void>;
  getOrder(orderId: string, symbol: string): Promise<IOrder>;
  getOrders(symbol?: string): Promise<IOrder[]>;
  getTrades(symbol?: string, limit?: number): Promise<Trade[]>;

  // Margin methods
  setLeverage(symbol: string, leverage: number): Promise<void>;
  setMarginMode(symbol: string, mode: 'isolated' | 'cross'): Promise<void>;

  // Utility methods
  getSymbols(): Promise<string[]>;
  validateSymbol(symbol: string): Promise<boolean>;
  getMinOrderSize(symbol: string): Promise<number>;
  getMaxOrderSize(symbol: string): Promise<number>;

  // Health check
  ping(): Promise<boolean>;
  getServerTime(): Promise<number>;

  // Calculation methods
  calculateAmountFromUSDT(symbol: string, usdtAmount: number): Promise<Decimal>;
  calculateUSDTFromAmount(symbol: string, amount: number): Promise<Decimal>;
  amountToPrecision(symbol: string, amount: Decimal): Decimal;
  calculateAmountFromUSDTPrecised(
    symbol: string,
    targetUsdtAmount: number,
    midPrice?: Decimal
  ): Promise<Decimal>;
  calculateCoinsFromContracts(symbol: string, contracts: Decimal): Promise<Decimal>;
  calculateContractsFromCoins(symbol: string, coins: Decimal): Promise<Decimal>;
}
