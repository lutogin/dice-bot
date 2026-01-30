import Decimal from 'decimal.js';

/**
 * Alert severity level
 */
export type AlertLevel = 'critical' | 'warning' | 'info';

/**
 * Alert channel
 */
export type AlertChannel = 'telegram' | 'discord' | 'slack' | 'email' | 'log';

/**
 * Alert context with additional data
 */
export interface AlertContext {
  /** Component that triggered the alert */
  component?: string;
  /** Error if applicable */
  error?: Error | string;
  /** Current price */
  price?: Decimal;
  /** Position data */
  position?: {
    lpValue?: Decimal;
    hedgeSize?: Decimal;
    marginRatio?: Decimal;
  };
  /** Risk metrics */
  risk?: {
    drawdownPercent?: Decimal;
    liquidationDistance?: Decimal;
  };
  /** Any additional key-value data */
  [key: string]: any;
}

/**
 * Alert message structure
 */
export interface Alert {
  /** Alert ID */
  id: string;
  /** Severity level */
  level: AlertLevel;
  /** Alert message */
  message: string;
  /** Additional context */
  context?: AlertContext;
  /** Timestamp */
  timestamp: number;
  /** Whether alert was sent */
  sent: boolean;
  /** Channels where alert was sent */
  sentTo: AlertChannel[];
  /** Error if sending failed */
  sendError?: string;
}

/**
 * Daily report data (stub structure for future LedgerService)
 */
export interface DailyReportData {
  /** Report date */
  date: string;
  /** Starting portfolio value */
  startValue: Decimal;
  /** Ending portfolio value */
  endValue: Decimal;
  /** Absolute PnL */
  pnlAbsolute: Decimal;
  /** Percentage PnL */
  pnlPercent: Decimal;
  /** LP position stats */
  lp: {
    feesCollected: Decimal;
    rebalanceCount: number;
    rangeResetCount: number;
  };
  /** Hedge position stats */
  hedge: {
    fundingReceived: Decimal;
    tradesCount: number;
    avgEntryPrice: Decimal;
  };
  /** Risk metrics */
  risk: {
    maxDrawdown: Decimal;
    avgMarginRatio: Decimal;
    emergencyExits: number;
  };
  /** Gas spent */
  gasSpentUsdc: Decimal;
  /** Net profit (after fees and gas) */
  netProfit: Decimal;
}

/**
 * Daily report result
 */
export interface DailyReportResult {
  /** Whether report was generated */
  success: boolean;
  /** Report data */
  data?: DailyReportData;
  /** Formatted message */
  message?: string;
  /** Whether report was sent */
  sent: boolean;
  /** Error if any */
  error?: string;
  /** Timestamp */
  timestamp: number;
}

/**
 * Alert history entry
 */
export interface AlertHistoryEntry {
  alert: Alert;
  acknowledged: boolean;
  acknowledgedAt?: number;
  acknowledgedBy?: string;
}

/**
 * Monitoring service configuration
 */
export interface MonitoringServiceConfig {
  /** Channels to use for critical alerts */
  criticalChannels: AlertChannel[];
  /** Channels to use for warning alerts */
  warningChannels: AlertChannel[];
  /** Channels to use for info alerts */
  infoChannels: AlertChannel[];
  /** Minimum interval between same alerts (deduplication) */
  deduplicationIntervalMs: number;
  /** Whether to log all alerts */
  logAllAlerts: boolean;
  /** Daily report time (cron expression) */
  dailyReportCron: string;
  /** Whether daily report is enabled */
  dailyReportEnabled: boolean;
  /** Max alerts to keep in history */
  maxHistorySize: number;
}

/**
 * Alert statistics
 */
export interface AlertStats {
  total: number;
  bySeverity: {
    critical: number;
    warning: number;
    info: number;
  };
  last24h: number;
  lastAlert?: Alert;
}
