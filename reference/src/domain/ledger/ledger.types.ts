import Decimal from 'decimal.js';

/**
 * Tick snapshot for analytics
 */
export interface TickSnapshot {
  /** Timestamp */
  timestamp: number;
  /** Price data */
  prices: {
    cexPrice: Decimal;
    dexPrice: Decimal;
    referencePrice: Decimal;
  };
  /** LP state */
  lp: {
    tokenId?: string;
    inRange: boolean;
    wethAmount: Decimal;
    usdcAmount: Decimal;
    totalValueUsdc: Decimal;
    tickLower: number;
    tickUpper: number;
    currentTick: number;
  };
  wallet: {
    usdc: Decimal;
    weth: Decimal;
    ethForGas: Decimal;
    totalValueUsdc: Decimal;
    wethValueUsdc: Decimal;
    ethValueUsdc?: Decimal;
  };
  /** Hedge state */
  hedge: {
    hasPosition: boolean;
    shortSizeEth: Decimal;
    shortNotionalUsdc: Decimal;
    unrealizedPnl: Decimal;
    equity: Decimal;
    liquidationDistancePercent: Decimal;
  };
  /** Portfolio totals */
  portfolio: {
    totalValueUsdc: Decimal;
    netExposureEth: Decimal;
    hedgeRatio: Decimal;
  };
}

/**
 * DEX transaction record
 */
export interface DexTxRecord {
  /** Transaction hash */
  txHash: string;
  /** Transaction type */
  type: 'collect_fees' | 'decrease_liquidity' | 'increase_liquidity' | 'mint' | 'burn' | 'swap' | 'approve' | 'other';
  /** Block number */
  blockNumber?: number;
  /** Gas used */
  gasUsed: Decimal;
  /** Gas price in gwei */
  gasPriceGwei?: Decimal;
  /** Cost in ETH */
  costEth: Decimal;
  /** Cost in USDC */
  costUsdc: Decimal;
  /** Timestamp */
  timestamp: number;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

/**
 * Hedge fill record
 */
export interface HedgeFillRecord {
  /** Order ID */
  orderId: string;
  /** Exchange ID */
  exchangeId: string;
  /** Symbol */
  symbol: string;
  /** Side: buy or sell */
  side: 'buy' | 'sell';
  /** Order type */
  orderType: 'market' | 'limit';
  /** Filled amount in base asset */
  filledAmount: Decimal;
  /** Filled notional in USDC */
  filledNotionalUsdc: Decimal;
  /** Average fill price */
  avgPrice: Decimal;
  /** Fees paid in USDC */
  feesUsdc: Decimal;
  /** Fee currency */
  feeCurrency?: string;
  /** Realized PnL from this fill */
  realizedPnl?: Decimal;
  /** Timestamp */
  timestamp: number;
  /** Metadata */
  metadata?: Record<string, any>;
}

/**
 * Funding payment record
 */
export interface FundingRecord {
  /** Exchange ID */
  exchangeId: string;
  /** Symbol */
  symbol: string;
  /** Funding rate */
  fundingRate: Decimal;
  /** Position size at funding */
  positionSize: Decimal;
  /** Payment amount (positive = received, negative = paid) */
  paymentUsdc: Decimal;
  /** Timestamp */
  timestamp: number;
}

/**
 * Uniswap fee collection record
 */
export interface UniFeeRecord {
  /** Token ID */
  tokenId: string;
  /** Transaction hash */
  txHash: string;
  /** Amount of token0 (WETH) collected */
  amount0: Decimal;
  /** Amount of token1 (USDC) collected */
  amount1: Decimal;
  /** Total value in USDC */
  totalUsdc: Decimal;
  /** Price at collection */
  priceAtCollection: Decimal;
  /** Timestamp */
  timestamp: number;
}

/**
 * PnL report for a period
 */
export interface PnLReport {
  /** Period start */
  from: number;
  /** Period end */
  to: number;
  /** Duration in ms */
  durationMs: number;

  // ==================== Revenue ====================
  /** Uniswap fees collected */
  feesUni: {
    weth: Decimal;
    usdc: Decimal;
    totalUsdc: Decimal;
    count: number;
  };

  /** Funding payments received/paid */
  funding: {
    received: Decimal;
    paid: Decimal;
    net: Decimal;
    count: number;
  };

  // ==================== Costs ====================
  /** Hedge trading PnL and costs */
  hedgePnl: {
    realizedPnl: Decimal;
    tradingFees: Decimal;
    netPnl: Decimal;
    tradeCount: number;
    volume: Decimal;
  };

  /** On-chain transaction costs */
  txCosts: {
    totalEth: Decimal;
    totalUsdc: Decimal;
    txCount: number;
    byType: Record<string, { count: number; costUsdc: Decimal }>;
  };

  // ==================== Summary ====================
  /** Net PnL */
  netPnl: Decimal;
  /** APR estimate (annualized) */
  aprPercent?: Decimal;
  /** Starting value */
  startingValueUsdc?: Decimal;
  /** Ending value */
  endingValueUsdc?: Decimal;
  /** Value change */
  valueChangeUsdc?: Decimal;

  /** Generated at */
  generatedAt: number;
}

/**
 * Ledger query options
 */
export interface LedgerQueryOptions {
  /** Start timestamp */
  from?: number;
  /** End timestamp */
  to?: number;
  /** Limit */
  limit?: number;
  /** Offset */
  offset?: number;
  /** Order by */
  orderBy?: 'timestamp' | 'amount';
  /** Order direction */
  orderDir?: 'asc' | 'desc';
}

/**
 * Ledger statistics
 */
export interface LedgerStats {
  /** Total ticks recorded */
  tickCount: number;
  /** Total DEX transactions */
  dexTxCount: number;
  /** Total hedge fills */
  hedgeFillCount: number;
  /** Total funding records */
  fundingCount: number;
  /** Total fee collections */
  feeCollectionCount: number;
  /** First record timestamp */
  firstRecordAt?: number;
  /** Last record timestamp */
  lastRecordAt?: number;
  /** Storage size estimate */
  storageSizeBytes?: number;
}
