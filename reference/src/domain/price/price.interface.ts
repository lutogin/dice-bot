import Decimal from 'decimal.js';
import {
  CexPriceData,
  DexPriceData,
  TwapData,
  ReferencePrice,
  PriceServiceConfig,
  PriceComparison,
  PriceCacheEntry,
} from './price.types';

export { Decimal };

/**
 * Quick CEX price result (cheap, no RPC)
 */
export interface QuickCexPrice {
  /** CEX mark price */
  price: Decimal;
  /** Timestamp */
  timestamp: number;
  /** Whether price is stale */
  isStale: boolean;
}

/**
 * Price Service interface
 * Gets fair price from multiple sources (CEX + DEX)
 */
export interface IPriceService {
  /**
   * Get CEX price only (cheap, no RPC calls)
   * Use for high-frequency telemetry (every 10-15 sec)
   * @returns Quick CEX price
   */
  getCexPriceOnly(): Promise<QuickCexPrice>;

  /**
   * Get CEX mark price
   * @param symbol - Trading symbol (optional, uses default from config)
   * @returns CEX price data
   */
  getCexMarkPrice(symbol?: string): Promise<CexPriceData>;

  /**
   * Get DEX pool price from sqrtPriceX96
   * @param poolAddress - Uniswap v3 pool address (optional, uses default)
   * @returns DEX price data
   */
  getDexPoolPrice(poolAddress?: string): Promise<DexPriceData>;

  /**
   * Get TWAP price from pool
   * @param poolAddress - Pool address (optional)
   * @param periodSeconds - TWAP period (optional, uses config default)
   * @returns TWAP data
   */
  getTwapPrice(poolAddress?: string, periodSeconds?: number): Promise<TwapData>;

  /**
   * Get aggregated reference price from all sources (CEX + DEX)
   * Expensive - makes RPC call for DEX price
   * Use sparingly or on trigger (every 60 sec or on-demand)
   * @returns Reference price with confidence info
   */
  getReferencePrice(): Promise<ReferencePrice>;

  /**
   * Compare prices from different sources
   * @returns Price comparison result
   */
  comparePrices(): Promise<PriceComparison>;

  /**
   * Get cached prices
   * @returns Current cache state
   */
  getCachedPrices(): PriceCacheEntry;

  /**
   * Force refresh all prices
   * @returns Updated reference price
   */
  refreshPrices(): Promise<ReferencePrice>;

  /**
   * Get current config
   */
  getConfig(): PriceServiceConfig;

  /**
   * Update config
   * @param config - Partial config to update
   */
  updateConfig(config: Partial<PriceServiceConfig>): void;

  /**
   * Check if price sources are healthy
   * @returns Whether both sources are responding
   */
  isHealthy(): Promise<boolean>;

  /**
   * Convert sqrtPriceX96 to human-readable price
   * @param sqrtPriceX96 - The sqrt price from pool
   * @param token0Decimals - Decimals of token0
   * @param token1Decimals - Decimals of token1
   * @param invert - Whether to invert the price
   * @returns Human-readable price
   */
  sqrtPriceX96ToPrice(
    sqrtPriceX96: bigint,
    token0Decimals: number,
    token1Decimals: number,
    invert?: boolean
  ): Decimal;

  /**
   * Convert tick to price
   * @param tick - The tick value
   * @param token0Decimals - Decimals of token0
   * @param token1Decimals - Decimals of token1
   * @param invert - Whether to invert the price
   * @returns Human-readable price
   */
  tickToPrice(
    tick: number,
    token0Decimals: number,
    token1Decimals: number,
    invert?: boolean
  ): Decimal;
}
