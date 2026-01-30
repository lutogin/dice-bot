import Decimal from 'decimal.js';

export type OrderSide = 'buy' | 'sell';
export type PositionSide = 'long' | 'short';
export type OrderType = 'market' | 'limit';
export type OrderStatus = 'open' | 'closed' | 'canceled' | 'rejected';
export type MarginMode = 'isolated' | 'cross';

export interface FundingRateData {
  symbol: string;
  rate: Decimal;
  timestamp: number;
  nextFundingTime: number;
  exchangeId: string; // binance, bybit, olx
  fundingInterval: number; // in hours!
}

export interface ExtendedOrder extends IOrder {
  exchangeId: string;
}

export interface MarketData {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  timestamp: number;
  exchangeId: string;
}

export interface OrderBookData {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number;
  exchangeId: string;
}

export interface Balance {
  asset: string;
  free: number;
  used: number;
  total: number;
}

export interface IFundingRate {
  symbol: string;
  info: any;
  timestamp?: number;
  fundingRate?: number;
  datetime?: string;
  markPrice?: number;
  indexPrice?: number;
  interestRate?: number;
  estimatedSettlePrice?: number;
  fundingTimestamp?: number;
  fundingDatetime?: string;
  nextFundingTimestamp?: number;
  nextFundingDatetime?: string;
  nextFundingRate?: number;
  previousFundingTimestamp?: number;
  previousFundingDatetime?: string;
  previousFundingRate?: number;
  interval?: string;
}

export function mapSideToPositionSide(side: string | any): PositionSide {
  switch (side.toLowerCase()) {
    case 'buy':
    case 'long':
      return 'long';
    case 'sell':
    case 'short':
      return 'short';
    default:
      throw new Error(`Invalid side: ${side}`);
  }
}

export interface IPosition {
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl?: number;
  marginType: MarginMode;
  leverage: number;
  contracts: number;
  contractSize?: number;
  realizedPnl?: number;
  liquidationPrice: number;
  stopLossPrice?: number;
  takeProfitPrice?: number;
  exchangeId: string;
}

export interface Trade {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount: number;
  price: number;
  cost: number;
  fee: {
    currency: string;
    cost: number;
  };
  timestamp: number;
  exchangeId: string;
}

export interface IArbitrageOpportunity {
  id: string;
  symbol: string;
  exchangeA: string;
  exchangeB: string;
  fundingRateA: number;
  fundingRateB: number;
  fundingDelta: number;
  spreadA: number;
  spreadB: number;
  expectedProfit: number;
  riskScore: number;
  timestamp: number;
  isExecutable: boolean;
}

export interface OriginalFundingRate {
  info: {
    symbol: string;
    markPrice: string;
    indexPrice: string;
    estimatedSettlePrice: string;
    lastFundingRate: string;
    interestRate: string;
    nextFundingTime: string;
    time: string;
  };
  symbol: string;
  markPrice: number;
  indexPrice: number;
  interestRate: number;
  estimatedSettlePrice: number;
  timestamp: number;
  datetime: string;
  fundingRate: number;
  fundingTimestamp: number;
  fundingDatetime: string;
  nextFundingRate?: number;
  nextFundingTimestamp?: number;
  nextFundingDatetime?: string;
  previousFundingRate?: number;
  previousFundingTimestamp?: number;
  previousFundingDatetime?: string;
  interval?: string;
}

export interface IOrder {
  id: string;
  clientOrderId: string | undefined;
  datetime?: string;
  timestamp: number;
  lastTradeTimestamp?: number;
  lastUpdateTimestamp?: number;
  status: 'open' | 'closed' | 'canceled' | string | undefined;
  symbol: string;
  type: string | undefined;
  timeInForce?: string | undefined;
  side: 'buy' | 'sell' | string | undefined;
  price: number;
  average?: number;
  amount: number;
  filled: number;
  remaining?: number;
  stopPrice?: number;
  triggerPrice?: number;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  cost?: number;
  trades?: Trade[];
  fee?: {
    currency: string | undefined;
    cost: number | undefined;
    rate?: number | undefined;
  };
  reduceOnly?: boolean | undefined;
  postOnly?: boolean | undefined;
  info?: any;
}
