import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { ILedgerService } from './ledger.interface';
import {
  RecordTickInput,
  RecordDexTxInput,
  RecordHedgeFillInput,
  RecordFundingInput,
  RecordUniFeeInput,
} from './ledger.interface';
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
 * In-memory storage for ledger records
 * In production, this would be backed by MongoDB
 */
interface LedgerStorage {
  ticks: TickSnapshot[];
  dexTxs: DexTxRecord[];
  hedgeFills: HedgeFillRecord[];
  funding: FundingRecord[];
  uniFees: UniFeeRecord[];
}

/**
 * Ledger Service
 * Records and queries all financial events for PnL tracking
 */
@injectable()
export class LedgerService implements ILedgerService {
  private readonly logger: ILogger;
  private storage: LedgerStorage;
  private isRunning: boolean = false;

  // Configuration
  private readonly maxTicksInMemory: number = 10000;
  private readonly maxRecordsPerType: number = 5000;

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE)
    private readonly configService: ConfigService,
  ) {
    this.logger = logger.child('LedgerService');

    // Initialize in-memory storage
    this.storage = {
      ticks: [],
      dexTxs: [],
      hedgeFills: [],
      funding: [],
      uniFees: [],
    };

    this.logger.info('LedgerService initialized');
  }

  // ==================== Recording Methods ====================

  /**
   * Record a tick snapshot
   */
  async recordTick(input: RecordTickInput): Promise<void> {
    const timestamp = Date.now();

    // Calculate portfolio totals
    const lpValueUsdc = input.lp.totalValueUsdc;
    const hedgeValueUsdc = input.hedge.equity;
    const walletValueUsdc = input.wallet.totalValueUsdc.add(
      input.wallet.ethValueUsdc || new Decimal(0),
    );
    const totalValueUsdc = lpValueUsdc.add(hedgeValueUsdc).add(walletValueUsdc);

    // Net ETH exposure = LP ETH - Short ETH
    const netExposureEth = input.lp.wethAmount.sub(input.hedge.shortSizeEth);

    // Hedge ratio = Short / LP ETH
    const hedgeRatio = input.lp.wethAmount.isZero()
      ? new Decimal(0)
      : input.hedge.shortSizeEth.div(input.lp.wethAmount);

    const tick: TickSnapshot = {
      timestamp,
      prices: input.prices,
      lp: input.lp,
      wallet: input.wallet,
      hedge: input.hedge,
      portfolio: {
        totalValueUsdc,
        netExposureEth,
        hedgeRatio,
      },
    };

    this.storage.ticks.push(tick);

    // Trim if too many
    if (this.storage.ticks.length > this.maxTicksInMemory) {
      this.storage.ticks = this.storage.ticks.slice(-this.maxTicksInMemory);
    }

    this.logger.info('Tick recorded', {
      totalValue: totalValueUsdc.toFixed(2),
      hedgeRatio: hedgeRatio.toFixed(4),
      tokenId: input.lp.tokenId,
      shortNotionalUsdc: input.hedge.shortNotionalUsdc.toFixed(2),
      tickCount: this.storage.ticks.length,
    });
  }

  /**
   * Record a DEX transaction
   */
  async recordDexTx(input: RecordDexTxInput): Promise<void> {
    const timestamp = Date.now();

    // Convert ETH cost to USDC if price is available
    let costEth = input.costEth;
    let costUsdc: Decimal;

    if (!costEth && input.gasUsed && input.gasPriceGwei) {
      costEth = input.gasUsed.mul(input.gasPriceGwei).div(1e9);
    }
    costEth = costEth || new Decimal(0);
    costUsdc = input.priceUsdc ? costEth.mul(input.priceUsdc) : new Decimal(0);

    const record: DexTxRecord = {
      txHash: input.txHash,
      type: input.type,
      blockNumber: input.blockNumber,
      gasUsed: input.gasUsed,
      gasPriceGwei: input.gasPriceGwei,
      costEth: costEth || new Decimal(0),
      costUsdc,
      timestamp,
      metadata: input.metadata,
    };

    this.storage.dexTxs.push(record);
    this.trimStorage('dexTxs');

    this.logger.info('DEX tx recorded', {
      txHash: input.txHash.slice(0, 10) + '...',
      type: input.type,
      costUsdc: costUsdc.toFixed(2),
    });
  }

  /**
   * Record a hedge fill
   */
  async recordHedgeFill(input: RecordHedgeFillInput): Promise<void> {
    const timestamp = Date.now();

    const filledNotionalUsdc = input.filledAmount.mul(input.avgPrice);

    const record: HedgeFillRecord = {
      orderId: input.orderId,
      exchangeId: input.exchangeId,
      symbol: input.symbol,
      side: input.side,
      orderType: input.orderType,
      filledAmount: input.filledAmount,
      filledNotionalUsdc,
      avgPrice: input.avgPrice,
      feesUsdc: input.feesUsdc,
      feeCurrency: input.feeCurrency,
      realizedPnl: input.realizedPnl,
      timestamp,
      metadata: input.metadata,
    };

    this.storage.hedgeFills.push(record);
    this.trimStorage('hedgeFills');

    this.logger.info('Hedge fill recorded', {
      orderId: input.orderId,
      side: input.side,
      amount: input.filledAmount.toFixed(6),
      price: input.avgPrice.toFixed(2),
      fees: input.feesUsdc.toFixed(4),
    });
  }

  /**
   * Record a funding payment
   */
  async recordFunding(input: RecordFundingInput): Promise<void> {
    const timestamp = Date.now();

    const record: FundingRecord = {
      exchangeId: input.exchangeId,
      symbol: input.symbol,
      fundingRate: input.fundingRate,
      positionSize: input.positionSize,
      paymentUsdc: input.paymentUsdc,
      timestamp,
    };

    this.storage.funding.push(record);
    this.trimStorage('funding');

    this.logger.info('Funding recorded', {
      rate: input.fundingRate.mul(100).toFixed(4) + '%',
      payment: input.paymentUsdc.toFixed(4),
    });
  }

  /**
   * Record Uniswap fee collection
   */
  async recordUniFee(input: RecordUniFeeInput): Promise<void> {
    const timestamp = Date.now();

    const priceAtCollection = input.priceUsdc || new Decimal(0);

    const wethValueUsdc = input.amount0.mul(priceAtCollection);
    const totalUsdc = wethValueUsdc.add(input.amount1);

    const record: UniFeeRecord = {
      tokenId: input.tokenId,
      txHash: input.txHash,
      amount0: input.amount0,
      amount1: input.amount1,
      totalUsdc,
      priceAtCollection,
      timestamp,
    };

    this.storage.uniFees.push(record);
    this.trimStorage('uniFees');

    this.logger.info('Uniswap fee recorded', {
      tokenId: input.tokenId,
      weth: input.amount0.toFixed(6),
      usdc: input.amount1.toFixed(2),
      totalUsdc: totalUsdc.toFixed(2),
    });
  }

  // ==================== PnL Computation ====================

  /**
   * Compute net PnL for a period
   */
  async computeNetPnl(from: number, to: number): Promise<PnLReport> {
    const durationMs = to - from;

    // Filter records by period
    const periodDexTxs = this.storage.dexTxs.filter(
      (r) => r.timestamp >= from && r.timestamp <= to,
    );
    const periodFills = this.storage.hedgeFills.filter(
      (r) => r.timestamp >= from && r.timestamp <= to,
    );
    const periodFunding = this.storage.funding.filter(
      (r) => r.timestamp >= from && r.timestamp <= to,
    );
    const periodUniFees = this.storage.uniFees.filter(
      (r) => r.timestamp >= from && r.timestamp <= to,
    );

    // Calculate Uniswap fees
    const feesUni = {
      weth: periodUniFees.reduce(
        (sum, r) => sum.add(r.amount0),
        new Decimal(0),
      ),
      usdc: periodUniFees.reduce(
        (sum, r) => sum.add(r.amount1),
        new Decimal(0),
      ),
      totalUsdc: periodUniFees.reduce(
        (sum, r) => sum.add(r.totalUsdc),
        new Decimal(0),
      ),
      count: periodUniFees.length,
    };

    // Calculate funding
    const fundingReceived = periodFunding
      .filter((r) => r.paymentUsdc.isPositive())
      .reduce((sum, r) => sum.add(r.paymentUsdc), new Decimal(0));
    const fundingPaid = periodFunding
      .filter((r) => r.paymentUsdc.isNegative())
      .reduce((sum, r) => sum.add(r.paymentUsdc.abs()), new Decimal(0));
    const funding = {
      received: fundingReceived,
      paid: fundingPaid,
      net: fundingReceived.sub(fundingPaid),
      count: periodFunding.length,
    };

    // Calculate hedge PnL
    const hedgeRealizedPnl = periodFills.reduce(
      (sum, r) => sum.add(r.realizedPnl || new Decimal(0)),
      new Decimal(0),
    );
    const hedgeFees = periodFills.reduce(
      (sum, r) => sum.add(r.feesUsdc),
      new Decimal(0),
    );
    const hedgeVolume = periodFills.reduce(
      (sum, r) => sum.add(r.filledNotionalUsdc),
      new Decimal(0),
    );
    const hedgePnl = {
      realizedPnl: hedgeRealizedPnl,
      tradingFees: hedgeFees,
      netPnl: hedgeRealizedPnl.sub(hedgeFees),
      tradeCount: periodFills.length,
      volume: hedgeVolume,
    };

    // Calculate tx costs
    const txCostsByType: Record<string, { count: number; costUsdc: Decimal }> =
      {};
    for (const tx of periodDexTxs) {
      if (!txCostsByType[tx.type]) {
        txCostsByType[tx.type] = { count: 0, costUsdc: new Decimal(0) };
      }
      txCostsByType[tx.type].count++;
      txCostsByType[tx.type].costUsdc = txCostsByType[tx.type].costUsdc.add(
        tx.costUsdc,
      );
    }
    const txCosts = {
      totalEth: periodDexTxs.reduce(
        (sum, r) => sum.add(r.costEth),
        new Decimal(0),
      ),
      totalUsdc: periodDexTxs.reduce(
        (sum, r) => sum.add(r.costUsdc),
        new Decimal(0),
      ),
      txCount: periodDexTxs.length,
      byType: txCostsByType,
    };

    // Calculate net PnL
    // Net = Uni fees + Funding net + Hedge PnL - Tx costs
    const netPnl = feesUni.totalUsdc
      .add(funding.net)
      .add(hedgePnl.netPnl)
      .sub(txCosts.totalUsdc);

    // Get starting and ending values from ticks
    const periodTicks = this.storage.ticks.filter(
      (t) => t.timestamp >= from && t.timestamp <= to,
    );
    let startingValueUsdc: Decimal | undefined;
    let endingValueUsdc: Decimal | undefined;
    let valueChangeUsdc: Decimal | undefined;
    let aprPercent: Decimal | undefined;

    if (periodTicks.length > 0) {
      startingValueUsdc = periodTicks[0].portfolio.totalValueUsdc;
      endingValueUsdc =
        periodTicks[periodTicks.length - 1].portfolio.totalValueUsdc;
      valueChangeUsdc = endingValueUsdc.sub(startingValueUsdc);

      // APR = (netPnl / startingValue) * (365 days / duration)
      if (!startingValueUsdc.isZero() && durationMs > 0) {
        const durationDays = durationMs / (24 * 60 * 60 * 1000);
        const periodReturn = netPnl.div(startingValueUsdc);
        aprPercent = periodReturn.div(durationDays).mul(365).mul(100);
      }
    }

    const report: PnLReport = {
      from,
      to,
      durationMs,
      feesUni,
      funding,
      hedgePnl,
      txCosts,
      netPnl,
      aprPercent,
      startingValueUsdc,
      endingValueUsdc,
      valueChangeUsdc,
      generatedAt: Date.now(),
    };

    this.logger.info('PnL report generated', {
      period: `${new Date(from).toISOString()} - ${new Date(to).toISOString()}`,
      netPnl: netPnl.toFixed(2),
      aprPercent: aprPercent?.toFixed(2),
    });

    return report;
  }

  /**
   * Get PnL for last N hours
   */
  async getRecentPnl(hours: number): Promise<PnLReport> {
    const to = Date.now();
    const from = to - hours * 60 * 60 * 1000;
    return this.computeNetPnl(from, to);
  }

  /**
   * Get daily PnL (last 24h)
   */
  async getDailyPnl(): Promise<PnLReport> {
    return this.getRecentPnl(24);
  }

  // ==================== Query Methods ====================

  async getTicks(options?: LedgerQueryOptions): Promise<TickSnapshot[]> {
    return this.queryRecords(this.storage.ticks, options);
  }

  async getDexTxs(options?: LedgerQueryOptions): Promise<DexTxRecord[]> {
    return this.queryRecords(this.storage.dexTxs, options);
  }

  async getHedgeFills(
    options?: LedgerQueryOptions,
  ): Promise<HedgeFillRecord[]> {
    return this.queryRecords(this.storage.hedgeFills, options);
  }

  async getFundingRecords(
    options?: LedgerQueryOptions,
  ): Promise<FundingRecord[]> {
    return this.queryRecords(this.storage.funding, options);
  }

  async getUniFees(options?: LedgerQueryOptions): Promise<UniFeeRecord[]> {
    return this.queryRecords(this.storage.uniFees, options);
  }

  async getStats(): Promise<LedgerStats> {
    const allRecords = [
      ...this.storage.ticks,
      ...this.storage.dexTxs,
      ...this.storage.hedgeFills,
      ...this.storage.funding,
      ...this.storage.uniFees,
    ];

    const timestamps = allRecords.map((r) => r.timestamp);
    const firstRecordAt =
      timestamps.length > 0 ? Math.min(...timestamps) : undefined;
    const lastRecordAt =
      timestamps.length > 0 ? Math.max(...timestamps) : undefined;

    return {
      tickCount: this.storage.ticks.length,
      dexTxCount: this.storage.dexTxs.length,
      hedgeFillCount: this.storage.hedgeFills.length,
      fundingCount: this.storage.funding.length,
      feeCollectionCount: this.storage.uniFees.length,
      firstRecordAt,
      lastRecordAt,
    };
  }

  // ==================== Helper Methods ====================

  private queryRecords<T extends { timestamp: number }>(
    records: T[],
    options?: LedgerQueryOptions,
  ): T[] {
    let result = [...records];

    // Filter by time
    if (options?.from) {
      result = result.filter((r) => r.timestamp >= options.from!);
    }
    if (options?.to) {
      result = result.filter((r) => r.timestamp <= options.to!);
    }

    // Sort
    const orderDir = options?.orderDir || 'desc';
    result.sort((a, b) =>
      orderDir === 'asc'
        ? a.timestamp - b.timestamp
        : b.timestamp - a.timestamp,
    );

    // Pagination
    const offset = options?.offset || 0;
    const limit = options?.limit || 100;
    result = result.slice(offset, offset + limit);

    return result;
  }

  private trimStorage(key: keyof Omit<LedgerStorage, 'ticks'>): void {
    const arr = this.storage[key];
    if (arr.length > this.maxRecordsPerType) {
      // @ts-ignore
      this.storage[key] = arr.slice(-this.maxRecordsPerType);
    }
  }

  // ==================== Lifecycle ====================

  async start(): Promise<void> {
    this.isRunning = true;
    this.logger.info('LedgerService started');
  }

  async stop(): Promise<void> {
    await this.flush();
    this.isRunning = false;
    this.logger.info('LedgerService stopped');
  }

  async flush(): Promise<void> {
    // In production, this would persist to MongoDB
    this.logger.debug('Ledger flushed', {
      ticks: this.storage.ticks.length,
      dexTxs: this.storage.dexTxs.length,
      hedgeFills: this.storage.hedgeFills.length,
      funding: this.storage.funding.length,
      uniFees: this.storage.uniFees.length,
    });
  }
}
