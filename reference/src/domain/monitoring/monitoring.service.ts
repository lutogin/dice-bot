import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { TelegramService } from '../../integrations/telegram';
import type { ILedgerService } from '../ledger';
import { IMonitoringService } from './monitoring.interface';
import {
  Alert,
  AlertContext,
  AlertLevel,
  AlertChannel,
  DailyReportResult,
  DailyReportData,
  MonitoringServiceConfig,
  AlertStats,
  AlertHistoryEntry,
} from './monitoring.types';

/**
 * Default monitoring service configuration
 */
const DEFAULT_CONFIG: MonitoringServiceConfig = {
  criticalChannels: ['telegram', 'log'],
  warningChannels: ['telegram', 'log'],
  infoChannels: ['log'],
  deduplicationIntervalMs: 180000, // 3 minute
  logAllAlerts: true,
  dailyReportCron: '0 0 9 * * *', // 9 AM daily
  dailyReportEnabled: true,
  maxHistorySize: 1000,
};

/**
 * Monitoring Service
 * Alerts and reports: critical (emergency), warnings (spread), daily report
 */
@injectable()
export class MonitoringService implements IMonitoringService {
  private readonly logger: ILogger;
  private config: MonitoringServiceConfig;
  private history: AlertHistoryEntry[] = [];
  private lastAlerts: Map<string, number> = new Map(); // For deduplication
  private dailyReportTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE) private readonly configService: ConfigService,
    @inject(TOKENS.TELEGRAM_SERVICE) private readonly telegramService: TelegramService,
    @inject(TOKENS.LEDGER_SERVICE) private readonly ledgerService: ILedgerService
  ) {
    this.logger = logger.child('MonitoringService');
    this.config = { ...DEFAULT_CONFIG };

    this.logger.info('MonitoringService initialized');
  }

  // ==================== Alert Methods ====================

  /**
   * Send critical alert (emergency situations)
   */
  async alertCritical(message: string, context?: AlertContext): Promise<Alert> {
    return this.sendAlert('critical', message, context);
  }

  /**
   * Send warning alert
   */
  async alertWarn(message: string, context?: AlertContext): Promise<Alert> {
    return this.sendAlert('warning', message, context);
  }

  /**
   * Send info alert
   */
  async alertInfo(message: string, context?: AlertContext): Promise<Alert> {
    return this.sendAlert('info', message, context);
  }

  /**
   * Internal method to send alert
   */
  private async sendAlert(
    level: AlertLevel,
    message: string,
    context?: AlertContext
  ): Promise<Alert> {
    const alert: Alert = {
      id: uuidv4(),
      level,
      message,
      context,
      timestamp: Date.now(),
      sent: false,
      sentTo: [],
    };

    // Check deduplication
    const dedupeKey = `${level}:${message}`;
    const lastSent = this.lastAlerts.get(dedupeKey);
    const now = Date.now();

    if (lastSent && now - lastSent < this.config.deduplicationIntervalMs) {
      this.logger.debug('Alert deduplicated', { level, message });
      return alert;
    }

    // Get channels for this level
    const channels = this.getChannelsForLevel(level);

    // Send to each channel
    for (const channel of channels) {
      try {
        await this.sendToChannel(channel, alert);
        alert.sentTo.push(channel);
      } catch (error) {
        this.logger.error(`Failed to send alert to ${channel}`, error as Error);
        alert.sendError = (error as Error).message;
      }
    }

    alert.sent = alert.sentTo.length > 0;
    this.lastAlerts.set(dedupeKey, now);

    // Add to history
    this.addToHistory(alert);

    // Log if configured
    if (this.config.logAllAlerts) {
      this.logAlert(alert);
    }

    return alert;
  }

  /**
   * Get channels for alert level
   */
  private getChannelsForLevel(level: AlertLevel): AlertChannel[] {
    switch (level) {
      case 'critical':
        return this.config.criticalChannels;
      case 'warning':
        return this.config.warningChannels;
      case 'info':
        return this.config.infoChannels;
      default:
        return ['log'];
    }
  }

  /**
   * Send alert to specific channel
   */
  private async sendToChannel(channel: AlertChannel, alert: Alert): Promise<void> {
    const formattedMessage = this.formatAlertMessage(alert);

    switch (channel) {
      case 'telegram':
        await this.telegramService.sendMessageWithMarkdown(formattedMessage);
        break;

      case 'log':
        // Already logged if logAllAlerts is true
        break;

      case 'discord':
      case 'slack':
      case 'email':
        // TODO: Implement other channels
        this.logger.debug(`Channel ${channel} not implemented yet`);
        break;

      default:
        this.logger.warn(`Unknown channel: ${channel}`);
    }
  }

  /**
   * Format alert message for display
   */
  private formatAlertMessage(alert: Alert): string {
    const emoji = this.getAlertEmoji(alert.level);
    const levelText = alert.level.toUpperCase();
    const time = new Date(alert.timestamp).toISOString();

    let message = `${emoji} *${levelText}*\n\n${alert.message}`;

    if (alert.context) {
      message += '\n\n📋 *Context:*';

      if (alert.context.component) {
        message += `\n• Component: \`${alert.context.component}\``;
      }

      if (alert.context.price) {
        message += `\n• Price: $${alert.context.price.toFixed(2)}`;
      }

      if (alert.context.position) {
        const pos = alert.context.position;
        if (pos.lpValue) message += `\n• LP Value: $${pos.lpValue.toFixed(2)}`;
        if (pos.hedgeSize) message += `\n• Hedge Size: ${pos.hedgeSize.toFixed(4)} ETH`;
        if (pos.marginRatio) message += `\n• Margin Ratio: ${pos.marginRatio.mul(100).toFixed(2)}%`;
      }

      if (alert.context.risk) {
        const risk = alert.context.risk;
        if (risk.drawdownPercent) message += `\n• Drawdown: ${risk.drawdownPercent.toFixed(2)}%`;
        if (risk.liquidationDistance) message += `\n• Liq Distance: ${risk.liquidationDistance.toFixed(2)}%`;
      }

      if (alert.context.error) {
        const errorStr = typeof alert.context.error === 'string'
          ? alert.context.error
          : alert.context.error.message;
        message += `\n• Error: \`${errorStr}\``;
      }

      const flags = (alert.context as any).flags;
      if (flags && typeof flags === 'object') {
        const enabledFlags = Object.entries(flags)
          .filter(([key, value]) => typeof value === 'boolean' && value)
          .map(([key]) => key);
        if (enabledFlags.length > 0) {
          message += `\n• Flags: ${enabledFlags.join(', ')}`;
        }
      }

      const reasons = (alert.context as any).reasons;
      if (Array.isArray(reasons) && reasons.length > 0) {
        message += `\n• Reasons:`;
        for (const reason of reasons) {
          message += `\n  - ${reason}`;
        }
      }

      const extraContext = Object.entries(alert.context)
        .filter(([key, value]) =>
          !['component', 'price', 'position', 'risk', 'error', 'flags', 'reasons'].includes(key) &&
          value !== undefined
        )
        .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`);

      if (extraContext.length > 0) {
        message += `\n• Details: ${extraContext.join(', ')}`;
      }
    }

    message += `\n\n🕐 ${time}`;

    return message;
  }

  /**
   * Get emoji for alert level
   */
  private getAlertEmoji(level: AlertLevel): string {
    switch (level) {
      case 'critical':
        return '🚨';
      case 'warning':
        return '⚠️';
      case 'info':
        return 'ℹ️';
      default:
        return '📢';
    }
  }

  /**
   * Log alert based on level
   */
  private logAlert(alert: Alert): void {
    const meta = {
      alertId: alert.id,
      context: alert.context,
      sentTo: alert.sentTo,
    };

    switch (alert.level) {
      case 'critical':
        this.logger.error(`[ALERT] ${alert.message}`, null, meta);
        break;
      case 'warning':
        this.logger.warn(`[ALERT] ${alert.message}`, meta);
        break;
      case 'info':
        this.logger.info(`[ALERT] ${alert.message}`, meta);
        break;
    }
  }

  // ==================== Daily Report ====================

  /**
   * Generate and send daily report
   * Steps:
   * 1. Get PnL for last 24h from LedgerService
   * 2. Format message
   * 3. Send via Telegram
   */
  async dailyReport(): Promise<DailyReportResult> {
    const timestamp = Date.now();

    try {
      this.logger.info('Generating daily report...');

      // 1. Get PnL data from LedgerService
      const data = await this.buildReportFromLedger();

      // 2. Format report message
      const message = this.formatDailyReport(data);

      // 3. Send report
      let sent = false;
      try {
        await this.telegramService.sendMessageWithMarkdown(message);
        sent = true;
      } catch (error) {
        this.logger.error('Failed to send daily report', error as Error);
      }

      const result: DailyReportResult = {
        success: true,
        data,
        message,
        sent,
        timestamp,
      };

      this.logger.info('Daily report generated', { sent });

      return result;
    } catch (error) {
      this.logger.error('Failed to generate daily report', error as Error);

      return {
        success: false,
        sent: false,
        error: (error as Error).message,
        timestamp,
      };
    }
  }

  /**
   * Build report data from LedgerService
   */
  private async buildReportFromLedger(): Promise<DailyReportData> {
    try {
      // Get daily PnL report from LedgerService
      const pnlReport = await this.ledgerService.getDailyPnl();

      // Get ticks for start/end values
      const ticks = await this.ledgerService.getTicks({
        from: pnlReport.from,
        to: pnlReport.to,
        orderDir: 'asc',
        limit: 1000,
      });

      // Calculate values
      const startValue = pnlReport.startingValueUsdc || new Decimal(0);
      const endValue = pnlReport.endingValueUsdc || new Decimal(0);
      const pnlAbsolute = pnlReport.netPnl;
      const pnlPercent = startValue.isZero()
        ? new Decimal(0)
        : pnlAbsolute.div(startValue).mul(100);

      // Count rebalances and range resets from DEX txs
      const dexTxs = await this.ledgerService.getDexTxs({
        from: pnlReport.from,
        to: pnlReport.to,
      });

      const rebalanceCount = dexTxs.filter(tx => tx.type === 'swap').length;
      const rangeResetCount = dexTxs.filter(tx => tx.type === 'mint' || tx.type === 'burn').length;

      // Get hedge fills for trades info
      const hedgeFills = await this.ledgerService.getHedgeFills({
        from: pnlReport.from,
        to: pnlReport.to,
      });

      const avgEntryPrice = hedgeFills.length > 0
        ? hedgeFills.reduce((sum, f) => sum.add(f.avgPrice), new Decimal(0)).div(hedgeFills.length)
        : new Decimal(0);

      // Calculate max drawdown from ticks
      let maxDrawdown = new Decimal(0);
      let peakValue = new Decimal(0);
      let totalMarginRatio = new Decimal(0);

      for (const tick of ticks) {
        const value = tick.portfolio.totalValueUsdc;
        if (value.gt(peakValue)) {
          peakValue = value;
        }
        const drawdown = peakValue.isZero()
          ? new Decimal(0)
          : peakValue.sub(value).div(peakValue).mul(100);
        if (drawdown.gt(maxDrawdown)) {
          maxDrawdown = drawdown;
        }
        totalMarginRatio = totalMarginRatio.add(tick.hedge.equity.isZero()
          ? new Decimal(0)
          : tick.hedge.shortNotionalUsdc.div(tick.hedge.equity));
      }

      const avgMarginRatio = ticks.length > 0
        ? totalMarginRatio.div(ticks.length)
        : new Decimal(0);

      // Build report data
      const data: DailyReportData = {
        date: new Date(pnlReport.from).toISOString().split('T')[0],
        startValue,
        endValue,
        pnlAbsolute,
        pnlPercent,
        lp: {
          feesCollected: pnlReport.feesUni.totalUsdc,
          rebalanceCount,
          rangeResetCount,
        },
        hedge: {
          fundingReceived: pnlReport.funding.net,
          tradesCount: pnlReport.hedgePnl.tradeCount,
          avgEntryPrice,
        },
        risk: {
          maxDrawdown,
          avgMarginRatio,
          emergencyExits: 0, // TODO: track in ledger
        },
        gasSpentUsdc: pnlReport.txCosts.totalUsdc,
        netProfit: pnlReport.netPnl,
      };

      return data;
    } catch (error) {
      this.logger.error('Failed to build report from ledger', error as Error);
      return this.getStubReportData();
    }
  }

  /**
   * Get stub report data (placeholder for LedgerService)
   */
  private getStubReportData(): DailyReportData {
    return {
      date: new Date().toISOString().split('T')[0],
      startValue: new Decimal(0),
      endValue: new Decimal(0),
      pnlAbsolute: new Decimal(0),
      pnlPercent: new Decimal(0),
      lp: {
        feesCollected: new Decimal(0),
        rebalanceCount: 0,
        rangeResetCount: 0,
      },
      hedge: {
        fundingReceived: new Decimal(0),
        tradesCount: 0,
        avgEntryPrice: new Decimal(0),
      },
      risk: {
        maxDrawdown: new Decimal(0),
        avgMarginRatio: new Decimal(0),
        emergencyExits: 0,
      },
      gasSpentUsdc: new Decimal(0),
      netProfit: new Decimal(0),
    };
  }

  /**
   * Format daily report message
   */
  private formatDailyReport(data: DailyReportData): string {
    const pnlEmoji = data.pnlAbsolute.greaterThanOrEqualTo(0) ? '📈' : '📉';
    const pnlSign = data.pnlAbsolute.greaterThanOrEqualTo(0) ? '+' : '';

    return `
📊 *Daily Report - ${data.date}*

${pnlEmoji} *Performance*
• Start Value: $${data.startValue.toFixed(2)}
• End Value: $${data.endValue.toFixed(2)}
• PnL: ${pnlSign}$${data.pnlAbsolute.toFixed(2)} (${pnlSign}${data.pnlPercent.toFixed(2)}%)
• Net Profit: ${pnlSign}$${data.netProfit.toFixed(2)}

💧 *LP Activity*
• Fees Collected: $${data.lp.feesCollected.toFixed(2)}
• Rebalances: ${data.lp.rebalanceCount}
• Range Resets: ${data.lp.rangeResetCount}

📉 *Hedge Activity*
• Funding Received: $${data.hedge.fundingReceived.toFixed(2)}
• Trades: ${data.hedge.tradesCount}
• Avg Entry: $${data.hedge.avgEntryPrice.toFixed(2)}

⚠️ *Risk Metrics*
• Max Drawdown: ${data.risk.maxDrawdown.toFixed(2)}%
• Avg Margin Ratio: ${data.risk.avgMarginRatio.mul(100).toFixed(2)}%
• Emergency Exits: ${data.risk.emergencyExits}

⛽ *Costs*
• Gas Spent: $${data.gasSpentUsdc.toFixed(2)}

_Report generated at ${new Date().toISOString()}_
    `.trim();
  }

  // ==================== History & Stats ====================

  /**
   * Add alert to history
   */
  private addToHistory(alert: Alert): void {
    this.history.unshift({
      alert,
      acknowledged: false,
    });

    // Trim history if needed
    if (this.history.length > this.config.maxHistorySize) {
      this.history = this.history.slice(0, this.config.maxHistorySize);
    }
  }

  /**
   * Get alert history
   */
  getAlertHistory(limit?: number): AlertHistoryEntry[] {
    const count = limit || this.config.maxHistorySize;
    return this.history.slice(0, count);
  }

  /**
   * Get alert statistics
   */
  getAlertStats(): AlertStats {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;

    const stats: AlertStats = {
      total: this.history.length,
      bySeverity: {
        critical: 0,
        warning: 0,
        info: 0,
      },
      last24h: 0,
    };

    for (const entry of this.history) {
      stats.bySeverity[entry.alert.level]++;

      if (entry.alert.timestamp >= dayAgo) {
        stats.last24h++;
      }
    }

    if (this.history.length > 0) {
      stats.lastAlert = this.history[0].alert;
    }

    return stats;
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string, acknowledgedBy?: string): void {
    const entry = this.history.find(e => e.alert.id === alertId);
    if (entry) {
      entry.acknowledged = true;
      entry.acknowledgedAt = Date.now();
      entry.acknowledgedBy = acknowledgedBy;
    }
  }

  /**
   * Clear alert history
   */
  clearHistory(): void {
    this.history = [];
    this.lastAlerts.clear();
    this.logger.info('Alert history cleared');
  }

  // ==================== Configuration ====================

  getConfig(): MonitoringServiceConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<MonitoringServiceConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Monitoring config updated', config);
  }

  // ==================== Lifecycle ====================

  /**
   * Start scheduled tasks
   */
  start(): void {
    if (this.isRunning) {
      this.logger.warn('MonitoringService already running');
      return;
    }

    this.isRunning = true;

    // Schedule daily report
    if (this.config.dailyReportEnabled) {
      // Simple interval-based approach (for proper cron, use SchedulerService)
      // Run at configured time (default 9 AM)
      this.scheduleDailyReport();
    }

    this.logger.info('MonitoringService started');
  }

  /**
   * Schedule daily report
   */
  private scheduleDailyReport(): void {
    // Calculate ms until next 9 AM
    const now = new Date();
    const next9am = new Date(now);
    next9am.setHours(9, 0, 0, 0);

    if (next9am <= now) {
      next9am.setDate(next9am.getDate() + 1);
    }

    const msUntilNext = next9am.getTime() - now.getTime();

    this.dailyReportTimer = setTimeout(() => {
      this.dailyReport().catch(e => this.logger.error('Daily report failed', e as Error));

      // Schedule next day
      this.dailyReportTimer = setInterval(() => {
        this.dailyReport().catch(e => this.logger.error('Daily report failed', e as Error));
      }, 24 * 60 * 60 * 1000);
    }, msUntilNext);

    this.logger.info('Daily report scheduled', {
      nextRun: next9am.toISOString(),
      msUntilNext,
    });
  }

  /**
   * Stop scheduled tasks
   */
  stop(): void {
    if (this.dailyReportTimer) {
      clearTimeout(this.dailyReportTimer);
      clearInterval(this.dailyReportTimer);
      this.dailyReportTimer = null;
    }

    this.isRunning = false;
    this.logger.info('MonitoringService stopped');
  }
}
