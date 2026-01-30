import Decimal from 'decimal.js';

/**
 * Risk check status
 */
export type RiskCheckStatus = 'ok' | 'warning' | 'critical' | 'unknown';

/**
 * Risk flags returned by evaluate()
 */
export interface RiskFlags {
  /** Emergency exit required */
  emergency: boolean;
  /** CEX API is down or unresponsive */
  cexDown: boolean;
  /** RPC/DEX is down or unresponsive */
  rpcDown: boolean;
  /** Price spread is too wide (anomaly) */
  priceAnomaly: boolean;
  /** Margin is dangerously low */
  marginDanger: boolean;
  /** Liquidation price is too close */
  liquidationRisk: boolean;
  /** Max drawdown exceeded */
  drawdownExceeded: boolean;
  /** Price sources disagree */
  priceDisagreement: boolean;
  /** LP position is out of range */
  lpOutOfRange: boolean;
  /** Operation already in progress */
  operationInProgress: boolean;
  /** Reasons for each flag */
  reasons: string[];
  /** Timestamp */
  timestamp: number;
}

/**
 * Input for risk evaluation
 */
export interface RiskEvaluationInput {
  /** Price result from PriceService */
  priceResult?: {
    price: Decimal;
    isHealthy: boolean;
    /** Spread in basis points (optional) */
    spreadBps?: Decimal;
    /** Deviation between sources in percent (optional) */
    deviationPercent?: Decimal;
    source: string;
  };
  /** LP composition from LpPositionService */
  lpComposition?: {
    inRange: boolean;
    totalValueUsdc: Decimal;
    distanceToLowerPercent: Decimal;
    distanceToUpperPercent: Decimal;
  };
  /** Hedge snapshot from HedgeService */
  hedgeSnapshot?: {
    hasPosition: boolean;
    shortNotionalUsdc: Decimal;
    marginRatio?: Decimal;
    liquidationDistancePercent: Decimal;
    apiHealth: {
      isHealthy: boolean;
      lastSuccessTimestamp: number;
      consecutiveErrors?: number;
      consecutivePositionFailures?: number;
      consecutiveMarginFailures?: number;
    };
  };
}

/**
 * Generic risk check result
 */
export interface RiskCheckResult {
  /** Check name */
  name: string;
  /** Check status */
  status: RiskCheckStatus;
  /** Current value */
  value: Decimal | number | string;
  /** Threshold that triggered the status */
  threshold?: Decimal | number | string;
  /** Human-readable message */
  message: string;
  /** Timestamp of check */
  timestamp: number;
  /** Additional context */
  context?: Record<string, any>;
}

/**
 * Drawdown check result
 */
export interface DrawdownCheckResult extends RiskCheckResult {
  currentPnl: Decimal;
  peakValue: Decimal;
  currentValue: Decimal;
  drawdownPercent: Decimal;
  maxDrawdownPercent: Decimal;
}

/**
 * Margin check result
 */
export interface MarginCheckResult extends RiskCheckResult {
  marginRatio: Decimal;
  availableMargin: Decimal;
  maintenanceMargin: Decimal;
  liquidationDistance: Decimal;
  minBufferPercent: Decimal;
}

/**
 * DEX health check result
 */
export interface DexHealthResult extends RiskCheckResult {
  rpcLatencyMs: number;
  lastBlockNumber?: number;
  blockLag?: number;
  avgSlot0LatencyMs?: number;
  secondsSinceBlockUpdate?: number;
  revertRate?: Decimal;
  gasPriceGwei?: Decimal;
  rpcHealthy: boolean;
}

/**
 * CEX health check result
 */
export interface CexHealthResult extends RiskCheckResult {
  apiLatencyMs: number;
  recentErrorCount: number;
  errorRatePercent: Decimal;
  isConnected: boolean;
  lastSuccessfulRequest?: number;
  rateLimitRemaining?: number;
}

/**
 * Emergency exit decision
 */
export interface EmergencyExitDecision {
  shouldExit: boolean;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
  failedChecks: RiskCheckResult[];
  recommendedActions: string[];
  timestamp: number;
}

/**
 * Emergency exit result
 */
export interface EmergencyExitResult {
  success: boolean;
  actionsTaken: string[];
  actionsFailed: string[];
  finalBalances: {
    usdc: Decimal;
    eth: Decimal;
  };
  realizedPnl?: Decimal;
  durationMs: number;
  timestamp: number;
  errors: Error[];
}

/**
 * Risk thresholds configuration
 * MVP values for Arbitrum + Uniswap v3 WETH/USDC 0.05% + Binance perps
 */
export interface RiskThresholds {
  // ==================== Drawdown ====================
  /** Maximum drawdown percent before exit */
  maxDrawdownPercent: Decimal;
  /** Warning drawdown percent */
  warningDrawdownPercent: Decimal;

  // ==================== Margin / Liquidation ====================
  /** Minimum liquidation distance percent (safe) */
  minLiquidationDistancePercent: Decimal;
  /** Danger liquidation distance percent (urgent rehedge needed) */
  dangerLiquidationDistancePercent: Decimal;
  /** Emergency liquidation distance percent (immediate exit) */
  emergencyLiquidationDistancePercent: Decimal;
  /** Maximum margin ratio (maint/equity) before warning */
  maxMarginRatioPercent: Decimal;

  /** Minimum margin buffer percent (backward compat alias for minLiquidationDistancePercent) */
  minMarginBufferPercent: Decimal;
  /** Warning margin buffer percent */
  warningMarginBufferPercent: Decimal;

  // ==================== RPC Health ====================
  /** Maximum RPC latency ms */
  maxRpcLatencyMs: number;
  /** Maximum RPC error rate percent in last 60s */
  maxRpcErrorRatePercent: Decimal;
  /** Maximum block age seconds */
  maxBlockAgeSeconds: number;
  /** RPC down duration before emergency (seconds) */
  rpcDownEmergencySeconds: number;

  // ==================== CEX Health ====================
  /** CEX API timeout seconds (last success threshold) */
  cexTimeoutSeconds: number;
  /** CEX down duration before emergency (seconds) */
  cexDownEmergencySeconds: number;
  /** Maximum CEX API latency ms */
  maxCexLatencyMs: number;
  /** Warning CEX API latency ms */
  warningCexLatencyMs: number;

  // ==================== Price Anomaly ====================
  /** Maximum DEX-CEX spread percent (e.g., 0.006 = 0.6%) */
  maxDexCexSpreadPercent: Decimal;
  /** Maximum price spread in bps (for backward compatibility) */
  maxPriceSpreadBps: Decimal;
  /** TWAP window seconds */
  twapWindowSeconds: number;
  /** Max TWAP deviation from spot (fraction, e.g., 0.0065 = 0.65%) */
  maxTwapDeviationPercent: Decimal;
  /** CEX price stale seconds */
  cexPriceStaleSeconds: number;
  /** DEX price stale seconds */
  dexPriceStaleSeconds: number;

  // ==================== Gas ====================
  /** Maximum gas price gwei for operations */
  maxGasPriceGwei: Decimal;

  // ==================== Failures ====================
  /** Maximum consecutive failures before kill-switch */
  maxConsecutiveFailures: number;

  // ==================== Reset Limits ====================
  /** Minimum time between resets (seconds) */
  minTimeBetweenResetsSec: number;
  /** Maximum resets per 24 hours */
  maxResetsPer24h: number;

  // ==================== Rehedge Limits ====================
  /** Minimum time between rehedges (seconds) - cooldown */
  minRehedgeIntervalSec: number;
}

/**
 * Risk monitoring state
 */
export interface RiskMonitoringState {
  isMonitoring: boolean;
  lastFullCheck?: number;
  overallRiskLevel: RiskCheckStatus;
  checkResults: RiskCheckResult[];
  consecutiveFailures: number;
  peakValue: Decimal;
  valueHistory: Array<{ timestamp: number; value: Decimal }>;
  inEmergencyExit: boolean;
  operationInProgress: boolean;
  lastRiskFlags?: RiskFlags;
}

/**
 * Health metrics snapshot
 */
export interface HealthMetrics {
  dex: DexHealthResult;
  cex: CexHealthResult;
  margin: MarginCheckResult;
  drawdown: DrawdownCheckResult;
  overall: RiskCheckStatus;
  timestamp: number;
}
