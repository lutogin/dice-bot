import { ILogger } from 'infra/logger/logger';
import { IMonitoringService } from '../monitoring.interface';
import { Alert, AlertContext, AlertHistoryEntry, AlertLevel, AlertStats, DailyReportResult, MonitoringServiceConfig } from '../monitoring.types';

export class MockMonitoringService implements IMonitoringService {
  private readonly logger: ILogger;
  private alertCount = 0;
  private alertHistory: AlertHistoryEntry[] = [];

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  private createAlert(level: AlertLevel, message: string, context?: AlertContext): Alert {
    return {
      id: `mock_${++this.alertCount}`,
      level,
      message,
      context,
      timestamp: Date.now(),
      sent: true,
      sentTo: ['log'],
    };
  }

  async alertCritical(message: string, context?: AlertContext): Promise<Alert> {
    this.logger.warn(`[MOCK CRITICAL] ${message}`, context as Record<string, unknown>);
    const alert = this.createAlert('critical', message, context);
    this.alertHistory.push({ alert, acknowledged: false });
    return alert;
  }

  async alertWarn(message: string, context?: AlertContext): Promise<Alert> {
    this.logger.info(`[MOCK WARN] ${message}`, context as Record<string, unknown>);
    const alert = this.createAlert('warning', message, context);
    this.alertHistory.push({ alert, acknowledged: false });
    return alert;
  }

  async alertInfo(message: string, context?: AlertContext): Promise<Alert> {
    this.logger.debug(`[MOCK INFO] ${message}`, context as Record<string, unknown>);
    const alert = this.createAlert('info', message, context);
    this.alertHistory.push({ alert, acknowledged: false });
    return alert;
  }

  async dailyReport(): Promise<DailyReportResult> {
    return {
      success: true,
      sent: false,
      message: 'Mock daily report',
      timestamp: Date.now(),
    };
  }

  getAlertHistory(limit?: number): AlertHistoryEntry[] {
    return this.alertHistory.slice(-(limit || 100));
  }

  getAlertStats(): AlertStats {
    return {
      total: this.alertCount,
      bySeverity: { critical: 0, warning: 0, info: 0 },
      last24h: 0,
    };
  }

  acknowledgeAlert(_alertId: string, _acknowledgedBy?: string): void {}

  clearHistory(): void {
    this.alertHistory = [];
    this.alertCount = 0;
  }

  getConfig(): MonitoringServiceConfig {
    return {
      criticalChannels: ['log'],
      warningChannels: ['log'],
      infoChannels: ['log'],
      deduplicationIntervalMs: 60000,
      logAllAlerts: true,
      dailyReportCron: '0 9 * * *',
      dailyReportEnabled: false,
      maxHistorySize: 100,
    };
  }

  updateConfig(_config: Partial<MonitoringServiceConfig>): void {}

  start(): void {}
  stop(): void {}
}