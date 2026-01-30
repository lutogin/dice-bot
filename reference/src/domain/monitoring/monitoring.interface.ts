import {
  Alert,
  AlertContext,
  DailyReportResult,
  MonitoringServiceConfig,
  AlertStats,
  AlertHistoryEntry,
} from './monitoring.types';

/**
 * Monitoring Service interface
 * Alerts and reports: critical (emergency), warnings (spread), daily report
 *
 * Dependencies:
 * - ConfigService (where to send, levels)
 * - LedgerService (for daily report)
 */
export interface IMonitoringService {
  /**
   * Send critical alert (emergency situations)
   * @param message - Alert message
   * @param context - Additional context
   * @returns Alert object
   */
  alertCritical(message: string, context?: AlertContext): Promise<Alert>;

  /**
   * Send warning alert (spreads, deviations)
   * @param message - Alert message
   * @param context - Additional context
   * @returns Alert object
   */
  alertWarn(message: string, context?: AlertContext): Promise<Alert>;

  /**
   * Send info alert (status updates)
   * @param message - Alert message
   * @param context - Additional context
   * @returns Alert object
   */
  alertInfo(message: string, context?: AlertContext): Promise<Alert>;

  /**
   * Generate and send daily report
   * Steps:
   * 1. Get PnL for 24h from LedgerService
   * 2. Format message
   * 3. Send
   * @returns Report result
   */
  dailyReport(): Promise<DailyReportResult>;

  /**
   * Get alert history
   * @param limit - Max number of entries
   * @returns Alert history
   */
  getAlertHistory(limit?: number): AlertHistoryEntry[];

  /**
   * Get alert statistics
   * @returns Alert stats
   */
  getAlertStats(): AlertStats;

  /**
   * Acknowledge an alert
   * @param alertId - Alert ID
   * @param acknowledgedBy - Who acknowledged
   */
  acknowledgeAlert(alertId: string, acknowledgedBy?: string): void;

  /**
   * Clear alert history
   */
  clearHistory(): void;

  /**
   * Get current config
   */
  getConfig(): MonitoringServiceConfig;

  /**
   * Update config
   * @param config - Partial config to update
   */
  updateConfig(config: Partial<MonitoringServiceConfig>): void;

  /**
   * Start scheduled tasks (daily report)
   */
  start(): void;

  /**
   * Stop scheduled tasks
   */
  stop(): void;
}
