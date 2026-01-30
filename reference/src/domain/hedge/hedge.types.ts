import Decimal from 'decimal.js';

/**
 * Urgency level for hedge operations
 * Determines execution strategy
 */
export enum HedgeUrgency {
  /** Normal rehedge - try maker first, take time */
  NORMAL = 'NORMAL',
  /** Margin is dangerous - execute immediately, skip maker */
  MARGIN_DANGER = 'MARGIN_DANGER',
  /** After LP mint - moderate urgency */
  POST_RESET = 'POST_RESET',
}

/**
 * Order execution mode for hedge operations
 */
export type HedgeOrderMode = 'MAKER' | 'IOC' | 'MARKET' | 'NONE';

/**
 * Legacy mode type for backward compatibility
 */
export type HedgeOrderModeInput = 'makerPrefer' | 'iocMarket';

/**
 * API health status
 */
export interface ApiHealthStatus {
  /** Whether API is healthy */
  isHealthy: boolean;
  /** Last successful request timestamp */
  lastSuccessTimestamp: number;
  /** Consecutive error count */
  consecutiveErrors?: number;
  /** Consecutive failures fetching position */
  consecutivePositionFailures?: number;
  /** Consecutive failures fetching margin */
  consecutiveMarginFailures?: number;
  /** Last error if any */
  lastError?: string;
  /** Last error timestamp */
  lastErrorTimestamp?: number;
  /** Average response time in ms */
  avgResponseTimeMs: number;
  /** Error count in last hour */
  errorCountLastHour: number;
}

/**
 * Complete hedge snapshot including position, margin and health
 */
export interface HedgeSnapshot {
  /** Has open position */
  hasPosition: boolean;
  /** Short size in base asset (ETH) */
  shortSizeEth: Decimal;
  /** Short size in quote currency (USDC/USDT) */
  shortNotionalUsdc: Decimal;
  /** Entry price (if has position) */
  entryPrice: Decimal;
  /** Current mark price */
  markPrice: Decimal;
  /** Unrealized PnL in USDC */
  unrealizedPnl: Decimal;
  /** Current leverage */
  leverage: number;
  /** Margin type */
  marginType: 'cross' | 'isolated';

  // Margin info
  /** Total equity */
  equity: Decimal;
  /** Maintenance margin required */
  maintenanceMargin: Decimal;
  /** Liquidation price (0 if no position) */
  liquidationPrice: Decimal;
  /** Distance to liquidation in percent */
  liquidationDistancePercent: Decimal;
  /** Available balance */
  availableBalance: Decimal;
  /** Margin ratio (maint/equity, e.g., 0.20 = 20%) */
  marginRatio?: Decimal;

  // API health
  /** API health status */
  apiHealth: ApiHealthStatus;

  /** Snapshot timestamp */
  timestamp: number;
}

/**
 * Result of hedge adjustment operation (per spec)
 */
export interface HedgeAdjustResult {
  /** Whether order was executed */
  executed: boolean;
  /** Execution mode used */
  modeUsed: HedgeOrderMode;
  /** Amount changed in USDC (positive = increased short, negative = decreased) */
  deltaNotionalUsdc: Decimal;
  /** Average fill price */
  avgFillPrice: Decimal;
  /** Fees paid in USDC */
  feesPaid: Decimal;
  /** Reason/description */
  reason: string;

  // Additional details
  /** Operation type */
  operation: 'open' | 'increase' | 'decrease' | 'close' | 'noop';
  /** Amount changed in asset (ETH) */
  deltaEth: Decimal;
  /** Order ID(s) */
  orderIds: string[];
  /** New position size after adjustment */
  newShortNotionalUsdc: Decimal;
  /** New short size in ETH */
  newShortSizeEth: Decimal;
  /** Fill rate (0-1) */
  fillRate: Decimal;
  /** Slippage from mid price (bps) */
  slippageBps: Decimal;
  /** Number of maker attempts used */
  makerAttempts: number;
  /** Whether fallback was used */
  usedFallback: boolean;
  /** Execution timestamp */
  timestamp: number;

  // Legacy compatibility
  /** @deprecated Use deltaNotionalUsdc */
  deltaUsdc: Decimal;
  /** @deprecated Use avgFillPrice */
  avgExecutionPrice: Decimal;
  /** @deprecated Use feesPaid */
  feesUsdc: Decimal;
  /** @deprecated Use modeUsed */
  orderMode: HedgeOrderMode;
}

/**
 * Result of emergency close
 */
export interface EmergencyCloseResult {
  /** Whether close was successful */
  success: boolean;
  /** Amount closed in USDC */
  closedUsdc: Decimal;
  /** Amount closed in ETH */
  closedEth: Decimal;
  /** Execution price */
  executionPrice: Decimal;
  /** Fees paid */
  feesUsdc: Decimal;
  /** Order ID */
  orderId: string;
  /** Error message if failed */
  error?: string;
  /** Timestamp */
  timestamp: number;
}

// Legacy types for backward compatibility
export interface ShortPosition {
  symbol: string;
  side: 'short' | 'long';
  sizeInAsset: Decimal;
  sizeInUsdc: Decimal;
  entryPrice: Decimal;
  markPrice: Decimal;
  unrealizedPnl: Decimal;
  realizedPnl?: Decimal;
  leverage: number;
  marginType: 'cross' | 'isolated';
  liquidationPrice: Decimal;
  contracts: Decimal;
  exchangeId: string;
}

export interface MarginInfo {
  equity: Decimal;
  availableBalance: Decimal;
  usedMargin: Decimal;
  maintenanceMargin: Decimal;
  marginRatio: Decimal;
  liquidationDistance: Decimal;
  unrealizedPnl: Decimal;
  walletBalance: Decimal;
}

export interface HedgeAdjustmentResult {
  operation: 'open' | 'increase' | 'decrease' | 'close';
  amountUsdc: Decimal;
  amountAsset: Decimal;
  executionPrice: Decimal;
  orderId: string;
  orderType: 'limit' | 'market';
  newPositionSizeUsdc: Decimal;
  fees?: Decimal;
  timestamp: number;
}

export interface TargetShortConfig {
  targetNotionalUsdc: Decimal;
  useLimitOrders: boolean;
  maxSlippagePercent?: number;
  maxRetries?: number;
}

export interface EmergencyCloseParams {
  amount?: Decimal;
  closeAll?: boolean;
  useMarketOrder?: boolean;
}

// ==================== Hedge Execution Config ====================

/**
 * Configuration for maker-prefer execution strategy
 */
export interface HedgeExecutionConfig {
  /** Timeout for maker order to fill (ms) */
  makerTimeoutMs: number;
  /** Maximum maker attempts before fallback */
  maxMakerAttempts: number;
  /** Fallback mode when maker fails */
  fallbackMode: 'IOC' | 'MARKET';
  /** Max impact (slippage) in bps for NORMAL urgency */
  maxImpactBpsNormal: number;
  /** Max impact (slippage) in bps for MARGIN_DANGER urgency */
  maxImpactBpsDanger: number;
  /** Tick offset from best price for maker orders */
  makerTickOffset: number;
  /** Minimum notional to trigger rehedge */
  minRehedgeNotionalUsdc: number;
  /** Maximum single order size (USDC) - for chunking */
  maxOrderSizeUsdc: number;
  /** Delay between retry attempts (ms) */
  retryDelayMs: number;
}
