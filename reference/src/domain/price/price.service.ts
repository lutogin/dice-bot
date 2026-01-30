import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';
import { ethers } from 'ethers';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import type { IHedgeService } from '../hedge';
import { IPriceService, QuickCexPrice } from './price.interface';
import {
  CexPriceData,
  DexPriceData,
  TwapData,
  ReferencePrice,
  PriceServiceConfig,
  PriceComparison,
  PriceCacheEntry,
  AggregationMethod,
} from './price.types';
import { RetryUtils } from '../../infra/utils';

// Uniswap V3 Pool ABI (minimal)
const UNISWAP_V3_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
  'function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)',
];

/**
 * Default price service configuration
 */
const DEFAULT_CONFIG: PriceServiceConfig = {
  maxPriceAgeMs: 30000, // 30 seconds
  maxDeviationPercent: new Decimal(1), // 1%
  aggregationMethod: 'weighted',
  twapPeriodSeconds: 300, // 5 minutes
  useTwap: false,
  cexWeight: new Decimal(0.6),
  dexWeight: new Decimal(0.4),
  minSourcesForHighConfidence: 2,
};


/**
 * Price Service
 * Gets fair price from multiple sources (CEX mark price + DEX pool price)
 */
@injectable()
export class PriceService implements IPriceService {
  private readonly logger: ILogger;
  private readonly provider: ethers.JsonRpcProvider;
  private config: PriceServiceConfig;
  private cache: PriceCacheEntry;

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE) private readonly configService: ConfigService,
    @inject(TOKENS.HEDGE_SERVICE) private readonly hedgeService: IHedgeService
  ) {
    this.logger = logger.child('PriceService');

    // Initialize provider
    this.provider = new ethers.JsonRpcProvider(this.configService.web3.rpcUrl);

    // Initialize config from env/configService
    const priceConfig = this.configService.price;
    this.config = {
      ...DEFAULT_CONFIG,
      maxPriceAgeMs: priceConfig.maxPriceAgeMs,
      maxDeviationPercent: new Decimal(priceConfig.maxDeviationPercent),
      aggregationMethod: priceConfig.aggregationMethod,
      twapPeriodSeconds: priceConfig.twapPeriodSeconds,
      useTwap: priceConfig.useTwap,
      cexWeight: new Decimal(priceConfig.cexWeight),
      dexWeight: new Decimal(priceConfig.dexWeight),
      minSourcesForHighConfidence: priceConfig.minSourcesForHighConfidence,
    };

    // Initialize cache
    this.cache = {
      lastUpdate: 0,
    };

    this.logger.info('PriceService initialized', {
      poolAddress: this.configService.pool.poolAddress,
      hedgeSymbol: this.configService.hedgeExchange.hedgeSymbol,
    });
  }

  private resolveTokenAddressBySymbol(symbols: string[]): string | null {
    const { pool } = this.configService;
    const normalized = symbols.map(symbol => symbol.toLowerCase());

    if (normalized.includes(pool.token0Symbol.toLowerCase())) {
      return pool.token0Address;
    }
    if (normalized.includes(pool.token1Symbol.toLowerCase())) {
      return pool.token1Address;
    }
    return null;
  }

  /**
   * Get CEX price only (cheap, no RPC calls)
   * Use for high-frequency telemetry (every 10-15 sec)
   */
  async getCexPriceOnly(): Promise<QuickCexPrice> {
    try {
      const cexData = await this.getCexMarkPrice();

      return {
        price: cexData.price,
        timestamp: cexData.timestamp,
        isStale: cexData.isStale,
      };
    } catch (error) {
      this.logger.error('Failed to get CEX price', error as Error);
      throw error;
    }
  }

  /**
   * Get CEX mark price
   */
  async getCexMarkPrice(symbol?: string): Promise<CexPriceData> {
    const startTime = Date.now();
    const tradingSymbol = symbol || this.configService.hedgeExchange.hedgeSymbol;

    try {
      // Use hedge service to get mark price
      const markPrice = await this.hedgeService.getCurrentPrice();

      const priceData: CexPriceData = {
        price: markPrice,
        source: 'cex',
        timestamp: Date.now(),
        ageMs: 0,
        symbol: tradingSymbol,
        isStale: false,
        markPrice: markPrice,
        exchangeId: this.configService.hedgeExchange.id,
      };

      // Update cache
      this.cache.cex = priceData;
      this.cache.lastUpdate = Date.now();

      // this.logger.debug('CEX price fetched', {
      //   price: markPrice.toFixed(2),
      //   symbol: tradingSymbol,
      //   latencyMs: Date.now() - startTime,
      // });

      return priceData;
    } catch (error) {
      this.logger.error('Failed to get CEX mark price', error as Error);
      throw error;
    }
  }

  /**
   * Get DEX pool price from sqrtPriceX96
   * Includes retry logic for transient RPC errors
   */
  async getDexPoolPrice(poolAddress?: string): Promise<DexPriceData> {
    const pool = poolAddress || this.configService.pool.poolAddress;

    try {
      return await RetryUtils.retry(
        async () => {
          const poolContract = new ethers.Contract(pool, UNISWAP_V3_POOL_ABI, this.provider);

          // Get slot0 for current price
          const slot0 = await poolContract.slot0();
          const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96.toString());
          const tick = Number(slot0.tick);

          // Get liquidity
          const liquidity = BigInt((await poolContract.liquidity()).toString());

          // Get tokens
          const token0 = await poolContract.token0();
          const token1 = await poolContract.token1();

          // Get fee
          const fee = Number(await poolContract.fee());

          // Calculate price
          const { token0Decimals, token1Decimals, token0Symbol, token1Symbol, token0Address } = this.configService.pool;
          const token0Lower = token0.toLowerCase();
          const token0MatchesConfig0 = token0Lower === token0Address.toLowerCase();
          const actualToken0Decimals = token0MatchesConfig0 ? token0Decimals : token1Decimals;
          const actualToken1Decimals = token0MatchesConfig0 ? token1Decimals : token0Decimals;
          const actualToken0Symbol = token0MatchesConfig0 ? token0Symbol : token1Symbol;
          const actualToken1Symbol = token0MatchesConfig0 ? token1Symbol : token0Symbol;

          const wethAddress = this.resolveTokenAddressBySymbol(['WETH', 'ETH']);
          const isToken0Base = wethAddress ? token0Lower === wethAddress.toLowerCase() : actualToken0Symbol === 'WETH';
          const price = this.sqrtPriceX96ToPrice(
            sqrtPriceX96,
            actualToken0Decimals,
            actualToken1Decimals,
            !isToken0Base
          );

          const priceData: DexPriceData = {
            price,
            source: 'dex',
            timestamp: Date.now(),
            ageMs: 0,
            symbol: `${actualToken0Symbol}/${actualToken1Symbol}`,
            isStale: false,
            poolAddress: pool,
            sqrtPriceX96,
            tick,
            token0,
            token1,
            liquidity,
            feeTier: fee,
            isToken0Base,
          };

          // Update cache
          this.cache.dex = priceData;
          this.cache.lastUpdate = Date.now();

          return priceData;
        },
        { maxRetries: 2, baseDelay: 500, maxDelay: 2000 }
      );
    } catch (error) {
      // Log as warn, not error - this is a transient RPC issue
      this.logger.warn('Failed to get DEX pool price after retries', {
        error: (error as Error).message,
        pool,
      });
      throw error;
    }
  }

  /**
   * Get TWAP price from pool
   * Includes retry logic for transient RPC errors
   */
  async getTwapPrice(poolAddress?: string, periodSeconds?: number): Promise<TwapData> {
    const pool = poolAddress || this.configService.pool.poolAddress;
    const period = periodSeconds || this.config.twapPeriodSeconds;

    try {
      return await RetryUtils.retry(
        async () => {
          const poolContract = new ethers.Contract(pool, UNISWAP_V3_POOL_ABI, this.provider);

          // Query observations at [period, 0] seconds ago
          const secondsAgos = [period, 0];
          const [tickCumulatives] = await poolContract.observe(secondsAgos);

          const startTickCumulative = BigInt(tickCumulatives[0].toString());
          const endTickCumulative = BigInt(tickCumulatives[1].toString());

          // Calculate TWAP tick
          const tickDiff = endTickCumulative - startTickCumulative;
          const twapTick = Number(tickDiff / BigInt(period));

          // Convert tick to price
          const { token0Decimals, token1Decimals, token0Symbol, token0Address } = this.configService.pool;
          const poolToken0 = await poolContract.token0();
          const token0MatchesConfig0 = poolToken0.toLowerCase() === token0Address.toLowerCase();
          const actualToken0Decimals = token0MatchesConfig0 ? token0Decimals : token1Decimals;
          const actualToken1Decimals = token0MatchesConfig0 ? token1Decimals : token0Decimals;
          const actualToken0Symbol = token0MatchesConfig0 ? token0Symbol : this.configService.pool.token1Symbol;

          const wethAddress = this.resolveTokenAddressBySymbol(['WETH', 'ETH']);
          const isToken0Base = wethAddress
            ? poolToken0.toLowerCase() === wethAddress.toLowerCase()
            : actualToken0Symbol === 'WETH';
          const price = this.tickToPrice(twapTick, actualToken0Decimals, actualToken1Decimals, !isToken0Base);

          const twapData: TwapData = {
            price,
            periodSeconds: period,
            observationsUsed: 2,
            startTick: Number(startTickCumulative),
            endTick: Number(endTickCumulative),
            timestamp: Date.now(),
          };

          // Update cache
          this.cache.twap = twapData;

          this.logger.debug('TWAP price calculated', {
            price: price.toFixed(2),
            periodSeconds: period,
            twapTick,
          });

          return twapData;
        },
        { maxRetries: 2, baseDelay: 500, maxDelay: 2000 }
      );
    } catch (error) {
      this.logger.warn('Failed to get TWAP price after retries', {
        error: (error as Error).message,
        pool,
        period,
      });
      throw error;
    }
  }

  /**
   * Get aggregated reference price
   */
  async getReferencePrice(): Promise<ReferencePrice> {
    const warnings: string[] = [];
    const sources: ('cex' | 'dex')[] = [];
    let cexPrice: Decimal | undefined;
    let dexPrice: Decimal | undefined;
    const now = Date.now();

    // Fetch prices in parallel
    const [cexResult, dexResult] = await Promise.allSettled([
      this.getCexMarkPrice(),
      this.config.useTwap ? this.getTwapPrice() : this.getDexPoolPrice(),
    ]);

    // Process CEX result
    if (cexResult.status === 'fulfilled') {
      cexResult.value.ageMs = now - cexResult.value.timestamp;
      cexResult.value.isStale = cexResult.value.ageMs > this.config.maxPriceAgeMs;
      cexPrice = cexResult.value.price;
      sources.push('cex');

      if (cexResult.value.isStale) {
        warnings.push('CEX price is stale');
      }
    } else {
      warnings.push(`CEX price unavailable: ${cexResult.reason}`);
    }

    // Process DEX result
    if (dexResult.status === 'fulfilled') {
      if ('source' in dexResult.value) {
        const dexData = dexResult.value as DexPriceData;
        dexData.ageMs = now - dexData.timestamp;
        dexData.isStale = dexData.ageMs > this.config.maxPriceAgeMs;
        dexPrice = dexData.price;
        sources.push('dex');
        if (dexData.isStale) {
          warnings.push('DEX price is stale');
        }
      } else {
        const twapData = dexResult.value as TwapData;
        dexPrice = twapData.price;
        sources.push('dex');
        const twapAgeMs = now - twapData.timestamp;
        if (twapAgeMs > this.config.maxPriceAgeMs) {
          warnings.push('TWAP price is stale');
        }
      }
    } else {
      warnings.push(`DEX price unavailable: ${dexResult.reason}`);
    }

    // Calculate deviation
    let deviationPercent = new Decimal(0);
    let isConsistent = true;

    if (cexPrice && dexPrice) {
      const diff = cexPrice.sub(dexPrice).abs();
      const avg = cexPrice.add(dexPrice).div(2);
      deviationPercent = diff.div(avg).mul(100);

      if (deviationPercent.greaterThan(this.config.maxDeviationPercent)) {
        isConsistent = false;
        warnings.push(`Price deviation ${deviationPercent.toFixed(2)}% exceeds threshold`);
      }
    }

    // Calculate reference price based on aggregation method
    let price: Decimal;
    let confidence: Decimal;

    if (sources.length === 0) {
      throw new Error('No price sources available');
    } else if (sources.length === 1) {
      price = cexPrice || dexPrice!;
      confidence = new Decimal(0.5);
      warnings.push('Only one price source available');
    } else {
      price = this.aggregatePrice(cexPrice!, dexPrice!, this.config.aggregationMethod);
      confidence = isConsistent ? new Decimal(1) : new Decimal(0.7);
    }

    const referencePrice: ReferencePrice = {
      price,
      confidence,
      sources,
      deviationPercent,
      cexPrice,
      dexPrice,
      isConsistent,
      timestamp: Date.now(),
      warnings,
    };

    // Update cache
    this.cache.reference = referencePrice;
    this.cache.lastUpdate = Date.now();

    this.logger.debug('Reference price calculated', {
      price: price.toFixed(2),
      confidence: confidence.toFixed(2),
      sources,
      deviation: deviationPercent.toFixed(4),
    });

    return referencePrice;
  }

  /**
   * Aggregate prices based on method
   */
  private aggregatePrice(cex: Decimal, dex: Decimal, method: AggregationMethod): Decimal {
    switch (method) {
      case 'mean':
        return cex.add(dex).div(2);

      case 'median':
        // With only 2 values, median = mean
        return cex.add(dex).div(2);

      case 'weighted':
        const totalWeight = this.config.cexWeight.add(this.config.dexWeight);
        return cex.mul(this.config.cexWeight).add(dex.mul(this.config.dexWeight)).div(totalWeight);

      case 'cex_priority':
        return cex;

      case 'dex_priority':
        return dex;

      default:
        return cex.add(dex).div(2);
    }
  }

  /**
   * Compare prices from different sources
   */
  async comparePrices(): Promise<PriceComparison> {
    const [cexResult, dexResult] = await Promise.allSettled([
      this.getCexMarkPrice(),
      this.getDexPoolPrice(),
    ]);

    const cexPrice = cexResult.status === 'fulfilled' ? cexResult.value.price : undefined;
    const dexPrice = dexResult.status === 'fulfilled' ? dexResult.value.price : undefined;

    let absoluteDiff = new Decimal(0);
    let percentDiff = new Decimal(0);

    if (cexPrice && dexPrice) {
      absoluteDiff = cexPrice.sub(dexPrice).abs();
      const avg = cexPrice.add(dexPrice).div(2);
      percentDiff = absoluteDiff.div(avg).mul(100);
    }

    const isWithinThreshold = percentDiff.lessThanOrEqualTo(this.config.maxDeviationPercent);

    // Prefer CEX for trading, DEX for on-chain operations
    const preferredSource = cexPrice ? 'cex' : 'dex';

    return {
      cexPrice,
      dexPrice,
      absoluteDiff,
      percentDiff,
      isWithinThreshold,
      preferredSource,
      timestamp: Date.now(),
    };
  }

  /**
   * Get cached prices
   */
  getCachedPrices(): PriceCacheEntry {
    // Update stale status
    const now = Date.now();

    if (this.cache.cex) {
      this.cache.cex.ageMs = now - this.cache.cex.timestamp;
      this.cache.cex.isStale = this.cache.cex.ageMs > this.config.maxPriceAgeMs;
    }

    if (this.cache.dex) {
      this.cache.dex.ageMs = now - this.cache.dex.timestamp;
      this.cache.dex.isStale = this.cache.dex.ageMs > this.config.maxPriceAgeMs;
    }

    return { ...this.cache };
  }

  /**
   * Force refresh all prices
   */
  async refreshPrices(): Promise<ReferencePrice> {
    this.logger.debug('Refreshing all prices');
    return this.getReferencePrice();
  }

  /**
   * Get current config
   */
  getConfig(): PriceServiceConfig {
    return { ...this.config };
  }

  /**
   * Update config
   */
  updateConfig(config: Partial<PriceServiceConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Price service config updated', config);
  }

  /**
   * Check if price sources are healthy
   */
  async isHealthy(): Promise<boolean> {
    try {
      const [cexResult, dexResult] = await Promise.allSettled([
        this.getCexMarkPrice(),
        this.getDexPoolPrice(),
      ]);

      return cexResult.status === 'fulfilled' && dexResult.status === 'fulfilled';
    } catch {
      return false;
    }
  }

  // ==================== Price Conversion Utilities ====================

  /**
   * Convert sqrtPriceX96 to human-readable price
   * Formula: price = (sqrtPriceX96 / 2^96)^2 * 10^(token0Decimals - token1Decimals)
   */
  sqrtPriceX96ToPrice(
    sqrtPriceX96: bigint,
    token0Decimals: number,
    token1Decimals: number,
    invert: boolean = false
  ): Decimal {
    // sqrtPriceX96 = sqrt(price) * 2^96
    // price = (sqrtPriceX96 / 2^96)^2
    const Q96 = BigInt(2) ** BigInt(96);

    // Use Decimal for precision
    const sqrtPrice = new Decimal(sqrtPriceX96.toString()).div(new Decimal(Q96.toString()));
    let price = sqrtPrice.pow(2);

    // Adjust for decimals
    // Price represents token1/token0
    // If token0 is WETH (18 decimals) and token1 is USDC (6 decimals):
    // raw price is in USDC/WETH with decimal adjustment needed
    const decimalAdjustment = new Decimal(10).pow(token0Decimals - token1Decimals);
    price = price.mul(decimalAdjustment);

    if (invert) {
      price = new Decimal(1).div(price);
    }

    return price;
  }

  /**
   * Convert tick to price
   * Formula: price = 1.0001^tick * 10^(token0Decimals - token1Decimals)
   */
  tickToPrice(
    tick: number,
    token0Decimals: number,
    token1Decimals: number,
    invert: boolean = false
  ): Decimal {
    // price = 1.0001^tick
    const base = new Decimal('1.0001');
    let price = base.pow(tick);

    // Adjust for decimals
    const decimalAdjustment = new Decimal(10).pow(token0Decimals - token1Decimals);
    price = price.mul(decimalAdjustment);

    if (invert) {
      price = new Decimal(1).div(price);
    }

    return price;
  }
}
