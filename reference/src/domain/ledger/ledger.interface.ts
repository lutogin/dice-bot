import Decimal from 'decimal.js';
import {
  TickSnapshot,
  DexTxRecord,
  HedgeFillRecord,
  FundingRecord,
  UniFeeRecord,
  PnLReport,
  LedgerQueryOptions,
  LedgerStats,
} from './ledger.types';

/**
 * Input for recording a tick snapshot
 */
export interface RecordTickInput {
  prices: {
    cexPrice: Decimal;
    dexPrice: Decimal;
    referencePrice: Decimal;
  };
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
  hedge: {
    hasPosition: boolean;
    shortSizeEth: Decimal;
    shortNotionalUsdc: Decimal;
    unrealizedPnl: Decimal;
    equity: Decimal;
    liquidationDistancePercent: Decimal;
  };
}

/**
 * Input for recording a DEX transaction
 */
export interface RecordDexTxInput {
  txHash: string;
  type: DexTxRecord['type'];
  gasUsed: Decimal;
  gasPriceGwei?: Decimal;
  costEth?: Decimal;
  priceUsdc?: Decimal;
  blockNumber?: number;
  metadata?: Record<string, any>;
}

/**
 * Input for recording a hedge fill
 */
export interface RecordHedgeFillInput {
  orderId: string;
  exchangeId: string;
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  filledAmount: Decimal;
  avgPrice: Decimal;
  feesUsdc: Decimal;
  feeCurrency?: string;
  realizedPnl?: Decimal;
  metadata?: Record<string, any>;
}

/**
 * Input for recording funding payment
 */
export interface RecordFundingInput {
  exchangeId: string;
  symbol: string;
  fundingRate: Decimal;
  positionSize: Decimal;
  paymentUsdc: Decimal;
}

/**
 * Input for recording Uniswap fee collection
 */
export interface RecordUniFeeInput {
  tokenId: string;
  txHash: string;
  amount0: Decimal;
  amount1: Decimal;
  priceUsdc?: Decimal;
}

/**
 * Ledger Service interface
 * Records and queries all financial events
 */
export interface ILedgerService {
  /**
   * Record a tick snapshot for analytics
   * @param input - Prices, LP state, hedge state
   */
  recordTick(input: RecordTickInput): Promise<void>;

  /**
   * Record a DEX transaction
   * @param input - Transaction details
   */
  recordDexTx(input: RecordDexTxInput): Promise<void>;

  /**
   * Record a hedge fill
   * @param input - Order fill details
   */
  recordHedgeFill(input: RecordHedgeFillInput): Promise<void>;

  /**
   * Record a funding payment
   * @param input - Funding details
   */
  recordFunding(input: RecordFundingInput): Promise<void>;

  /**
   * Record Uniswap fee collection
   * @param input - Fee collection details
   */
  recordUniFee(input: RecordUniFeeInput): Promise<void>;

  /**
   * Compute net PnL for a period
   * @param from - Start timestamp (ms)
   * @param to - End timestamp (ms)
   * @returns PnL report
   */
  computeNetPnl(from: number, to: number): Promise<PnLReport>;

  /**
   * Get PnL report for last N hours
   * @param hours - Number of hours
   * @returns PnL report
   */
  getRecentPnl(hours: number): Promise<PnLReport>;

  /**
   * Get daily PnL report (last 24h)
   * @returns PnL report
   */
  getDailyPnl(): Promise<PnLReport>;

  // ==================== Query Methods ====================

  /**
   * Get tick snapshots
   */
  getTicks(options?: LedgerQueryOptions): Promise<TickSnapshot[]>;

  /**
   * Get DEX transactions
   */
  getDexTxs(options?: LedgerQueryOptions): Promise<DexTxRecord[]>;

  /**
   * Get hedge fills
   */
  getHedgeFills(options?: LedgerQueryOptions): Promise<HedgeFillRecord[]>;

  /**
   * Get funding records
   */
  getFundingRecords(options?: LedgerQueryOptions): Promise<FundingRecord[]>;

  /**
   * Get Uniswap fee collections
   */
  getUniFees(options?: LedgerQueryOptions): Promise<UniFeeRecord[]>;

  /**
   * Get ledger statistics
   */
  getStats(): Promise<LedgerStats>;

  // ==================== Lifecycle ====================

  /**
   * Start the ledger service
   */
  start(): Promise<void>;

  /**
   * Stop the ledger service
   */
  stop(): Promise<void>;

  /**
   * Flush pending writes
   */
  flush(): Promise<void>;
}
