import Decimal from 'decimal.js';
import {
  HedgeSnapshot,
  HedgeAdjustResult,
  HedgeOrderMode,
  HedgeOrderModeInput,
  HedgeUrgency,
  EmergencyCloseResult,
  // Legacy types
  ShortPosition,
  MarginInfo,
  HedgeAdjustmentResult,
  TargetShortConfig,
  EmergencyCloseParams,
} from './hedge.types';
import type { FundingRateData } from '../../integrations/exchanges/common/exchange.types';

/**
 * Interface for managing hedge (short) positions on CEX
 */
export interface IHedgeService {
  /**
   * Get current position snapshot including margin and API health
   * @returns Complete hedge snapshot
   */
  getPosition(): Promise<HedgeSnapshot>;

  /**
   * Set target short position size in USDC notional
   * Uses maker-prefer strategy with fallback to IOC/market
   *
   * @param targetUsdc - Target short notional in USDC
   * @param urgency - Urgency level determines execution strategy:
   *   - NORMAL: try maker first, take time
   *   - MARGIN_DANGER: execute immediately, skip maker
   *   - POST_RESET: moderate urgency after LP mint
   * @returns Adjustment result with execution details
   */
  setTargetShortNotional(targetUsdc: Decimal, urgency: HedgeUrgency): Promise<HedgeAdjustResult>;

  /**
   * Set target short position (legacy signature)
   * @deprecated Use setTargetShortNotional(targetUsdc, urgency) instead
   */
  setTargetShortNotional(targetUsdc: Decimal, mode: HedgeOrderModeInput): Promise<HedgeAdjustResult>;

  /**
   * Emergency reduce-only close of entire position
   * Uses market order for fastest execution
   * @returns Close result
   */
  reduceOnlyCloseAll(): Promise<EmergencyCloseResult>;

  // ==================== Legacy methods (kept for compatibility) ====================

  /**
   * Get current short position details (legacy)
   * @param symbol - Trading symbol (optional, uses default from config)
   * @returns Short position or null if no position
   */
  getShortPosition(symbol?: string): Promise<ShortPosition | null>;

  /**
   * Get margin account information (legacy)
   * @returns Margin info
   */
  getMarginInfo(): Promise<MarginInfo>;

  /**
   * Emergency reduce-only close (legacy)
   * @param params - Emergency close parameters
   * @returns Close result
   */
  reduceOnlyClose(params: EmergencyCloseParams): Promise<HedgeAdjustmentResult>;

  /**
   * Open or increase short position by USDC amount
   * @param amountUsdc - Amount to short in USDC
   * @param useLimitOrder - Use limit order (default: true)
   * @returns Adjustment result
   */
  openOrIncreaseShort(amountUsdc: Decimal, useLimitOrder?: boolean): Promise<HedgeAdjustmentResult>;

  /**
   * Decrease short position by USDC amount
   * @param amountUsdc - Amount to close in USDC
   * @param useLimitOrder - Use limit order (default: true)
   * @returns Adjustment result
   */
  decreaseShort(amountUsdc: Decimal, useLimitOrder?: boolean): Promise<HedgeAdjustmentResult>;

  /**
   * Get current mark price for the hedge symbol
   * @returns Current mark price
   */
  getCurrentPrice(): Promise<Decimal>;

  /**
   * Get realized volatility for the hedge symbol
   * @param timeframe - Candle timeframe (default: '30m')
   * @param limit - Number of closed candles to use (default: 48)
   * @returns Realized volatility as Decimal (log-returns stddev)
   */
  getVolatility(timeframe?: string, limit?: number): Promise<Decimal>;

  /**
   * Check if hedge exchange is connected
   */
  isConnected(): boolean;

  /**
   * Connect to hedge exchange
   */
  connect(): Promise<void>;

  /**
   * Disconnect from hedge exchange
   */
  disconnect(): Promise<void>;

  /**
   * Sync position with LP
   * @param lpEthAmount - Amount of ETH in LP position
   * @returns Adjustment result or null if no action needed
   */
  syncWithLpPosition(lpEthAmount: Decimal): Promise<HedgeAdjustmentResult | null>;

  /**
   * Ping CEX to verify API connectivity
   */
  ping(): Promise<boolean>;

  /**
   * Get current funding rate snapshot for hedge symbol
   */
  getFundingRate(symbol?: string): Promise<FundingRateData>;

  /**
   * Estimate the cost of executing a hedge trade
   * Includes: spread cost, funding rate impact (8h), estimated slippage
   *
   * @param notionalUsdc - The notional size of the hedge trade in USDC
   * @returns Estimated cost in USDC
   */
  estimateHedgeCost(notionalUsdc: Decimal): Promise<Decimal>;
}
