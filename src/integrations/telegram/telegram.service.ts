import { injectable, inject } from 'tsyringe';
import TelegramBot from 'node-telegram-bot-api';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { EventBus } from '../../infra/event-bus/event-bus';
import {
  setupEventHandlers,
  EventHandler,
} from '../../infra/event-bus/event-bus.decorators';

@injectable()
export class TelegramService {
  private bot: TelegramBot | null = null;
  private readonly logger: ILogger;
  private adminChatId: string;

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
  ) {
    this.logger = logger.child('Telegram');
    this.adminChatId = config.telegram.adminChatId;
  }

  async start(): Promise<void> {
    const { botToken, adminChatId } = this.config.telegram;

    if (!botToken || !adminChatId) {
      this.logger.warn('Telegram not configured, skipping');
      return;
    }

    try {
      this.bot = new TelegramBot(botToken, { polling: true });
      this.adminChatId = adminChatId;

      this.setupCommands();
      setupEventHandlers(this);

      this.logger.info('Telegram bot started');

      // Send startup message
      const mode = this.config.isSimulation() ? '🎮 SIMULATION' : '💰 LIVE';
      await this.sendMessage(`🚀 FFE Trading Bot started (${mode})`);
    } catch (error) {
      this.logger.error('Failed to start Telegram bot', error as Error);
    }
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = null;
      this.logger.info('Telegram bot stopped');
    }
  }

  private setupCommands(): void {
    if (!this.bot) return;

    // /status - Get current bot status
    this.bot.onText(/\/status/, async (msg) => {
      if (msg.chat.id.toString() !== this.adminChatId) return;

      this.eventBus.emit('telegram.positions.request', {
        source: 'telegram',
        timestamp: Date.now(),
      });
    });

    // /kill - Activate kill switch
    this.bot.onText(/\/kill/, async (msg) => {
      if (msg.chat.id.toString() !== this.adminChatId) return;

      this.eventBus.emit('telegram.kill-switch.request', {
        source: 'telegram',
        timestamp: Date.now(),
      });

      await this.sendMessage('🛑 Kill switch command received');
    });

    // /metrics - Get daily metrics
    this.bot.onText(/\/metrics/, async (msg) => {
      if (msg.chat.id.toString() !== this.adminChatId) return;

      this.eventBus.emit('telegram.metrics.request', {
        source: 'telegram',
        timestamp: Date.now(),
      });
    });

    // /stats - Get overall statistics
    this.bot.onText(/\/stats/, async (msg) => {
      if (msg.chat.id.toString() !== this.adminChatId) return;

      this.eventBus.emit('telegram.stats.request', {
        source: 'telegram',
        timestamp: Date.now(),
      });
    });

    // /trades - Get recent trades
    this.bot.onText(/\/trades/, async (msg) => {
      if (msg.chat.id.toString() !== this.adminChatId) return;

      this.eventBus.emit('telegram.trades.request', {
        source: 'telegram',
        timestamp: Date.now(),
      });
    });

    // /help - Show available commands
    this.bot.onText(/\/help/, async (msg) => {
      if (msg.chat.id.toString() !== this.adminChatId) return;

      const mode = this.config.isSimulation() ? '🎮 SIMULATION' : '💰 LIVE';
      const helpText = `
*FFE Trading Bot Commands*
Mode: ${mode}

/status - Current positions and P&L
/stats - Overall trading statistics
/metrics - Today's metrics
/trades - Recent trades (last 5)
/kill - Activate kill switch
/help - Show this message
      `;

      await this.sendMessage(helpText, { parse_mode: 'Markdown' });
    });

    this.logger.debug('Telegram commands registered');
  }

  // ==================== Event Handlers ====================

  @EventHandler('forced-event.detected')
  async onForcedEvent(event: any): Promise<void> {
    const mode = this.config.isSimulation() ? ' [SIM]' : '';
    const message = `
🔥 *Forced Event Detected*${mode}

Symbol: ${event.symbol}
Type: ${event.type}
Direction: ${event.sideHint}
Severity: ${(event.severity * 100).toFixed(0)}%
Liq Notional: ${(event.snapshot.liqNotional30s / 1_000_000).toFixed(1)}M
Return (30s): ${(event.snapshot.ret30s * 100).toFixed(2)}%
    `;

    await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  @EventHandler('trade-plan.armed')
  async onPlanArmed(plan: any): Promise<void> {
    const mode = this.config.isSimulation() ? ' [SIM]' : '';
    const message = `
🎯 *Trade Plan Armed*${mode}

Symbol: ${plan.symbol}
Side: ${plan.side}
Entry Trigger: ${plan.entryTriggerPrice.toFixed(2)}
Stop: ${plan.stopPrice.toFixed(2)}
TP1: ${plan.tp1Price.toFixed(2)}
Risk: ${(plan.riskPercent * 100).toFixed(2)}%
    `;

    await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  @EventHandler('position.opened')
  async onPositionOpened(data: any): Promise<void> {
    const mode = data.simulation ? ' [SIM]' : '';
    const message = `
✅ *Position Opened*${mode}

Symbol: ${data.symbol}
Side: ${data.side}
Entry: ${data.entryPrice.toFixed(2)}
Size: ${data.qty.toFixed(4)}
Notional: ${data.notionalUsdc.toFixed(0)}
    `;

    await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  @EventHandler('position.closed')
  async onPositionClosed(data: any): Promise<void> {
    const mode = data.simulation ? ' [SIM]' : '';
    const emoji = data.pnlUsdc >= 0 ? '💰' : '💸';
    const message = `
${emoji} *Position Closed*${mode}

Symbol: ${data.symbol}
Side: ${data.side}
Entry: ${data.entryPrice.toFixed(2)}
Exit: ${data.exitPrice.toFixed(2)}
P&L: ${data.pnlUsdc >= 0 ? '+' : ''}${data.pnlUsdc.toFixed(2)} (${data.pnlR >= 0 ? '+' : ''}${data.pnlR.toFixed(2)}R)
Reason: ${data.reason}
MFE: ${(data.mfe * 100).toFixed(2)}% | MAE: ${(data.mae * 100).toFixed(2)}%
    `;

    await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  @EventHandler('risk.daily-limit-hit')
  async onDailyLimitHit(data: any): Promise<void> {
    const message = `
🛑 *DAILY LOSS LIMIT HIT*

Date: ${data.date}
Loss: ${data.lossUsdc.toFixed(2)}
Limit: ${data.limit.toFixed(2)}

Trading halted until next day.
    `;

    await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  @EventHandler('risk.trading-halted')
  async onTradingHalted(data: any): Promise<void> {
    await this.sendMessage(`⚠️ Trading halted: ${data.reason}`);
  }

  @EventHandler('position.stop-moved')
  async onStopMoved(data: any): Promise<void> {
    const mode = data.simulation ? ' [SIM]' : '';
    const emoji = data.reason === 'tp1_hit' ? '🎯' : '📈';
    const message = `
${emoji} *Stop Moved*${mode}

Symbol: ${data.symbol}
Old Stop: ${data.oldStop.toFixed(2)}
New Stop: ${data.newStop.toFixed(2)}
Reason: ${data.reason === 'tp1_hit' ? 'TP1 Hit - Breakeven' : 'Trailing'}
    `;

    await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  @EventHandler('error')
  async onError(data: any): Promise<void> {
    if (data.severity === 'critical' || data.severity === 'high') {
      const message = `
⚠️ *Error: ${data.source}*

${data.message}
      `;

      await this.sendMessage(message, { parse_mode: 'Markdown' });
    }
  }

  // ==================== Send Message ====================

  async sendMessage(
    text: string,
    options?: TelegramBot.SendMessageOptions,
  ): Promise<void> {
    if (!this.bot || !this.adminChatId) {
      this.logger.debug('Telegram not configured, message not sent', { text });
      return;
    }

    try {
      await this.bot.sendMessage(this.adminChatId, text.trim(), options);
    } catch (error) {
      this.logger.error('Failed to send Telegram message', error as Error);
    }
  }

  async sendStatusUpdate(data: {
    activePositions: number;
    pendingPlans: number;
    dailyPnl: number;
    equity: number;
    winRate?: number;
    tradesCount?: number;
    simulation?: boolean;
  }): Promise<void> {
    const mode = data.simulation ? '🎮 SIM' : '💰 LIVE';
    const message = `
📊 *Bot Status* (${mode})

Active Positions: ${data.activePositions}
Pending Plans: ${data.pendingPlans}
Daily P&L: ${data.dailyPnl >= 0 ? '+' : ''}${data.dailyPnl.toFixed(2)}
Equity: ${data.equity.toFixed(2)}
${data.tradesCount !== undefined ? `Trades Today: ${data.tradesCount}` : ''}
${data.winRate !== undefined ? `Win Rate: ${(data.winRate * 100).toFixed(0)}%` : ''}
    `;

    await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  async sendOverallStats(data: {
    totalTrades: number;
    totalPnlUsdc: number;
    winRate: number;
    avgR: number;
    profitFactor: number;
    simulation?: boolean;
  }): Promise<void> {
    const mode = data.simulation ? '🎮 SIMULATION' : '💰 LIVE';
    const pnlEmoji = data.totalPnlUsdc >= 0 ? '📈' : '📉';

    const message = `
📊 *Overall Statistics* (${mode})

Total Trades: ${data.totalTrades}
${pnlEmoji} Total P&L: ${data.totalPnlUsdc >= 0 ? '+' : ''}${data.totalPnlUsdc.toFixed(2)} USDT
Win Rate: ${(data.winRate * 100).toFixed(1)}%
Avg R: ${data.avgR >= 0 ? '+' : ''}${data.avgR.toFixed(2)}R
Profit Factor: ${data.profitFactor === Infinity ? '∞' : data.profitFactor.toFixed(2)}
    `;

    await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  async sendDailyMetrics(data: {
    date: string;
    tradesCount: number;
    wins: number;
    losses: number;
    winRate: number;
    pnlUsdc: number;
    pnlR: number;
    avgR: number;
    maxDrawdown: number;
    simulation?: boolean;
  }): Promise<void> {
    const mode = data.simulation ? '🎮 SIM' : '💰 LIVE';
    const pnlEmoji = data.pnlUsdc >= 0 ? '📈' : '📉';

    const message = `
📅 *Daily Metrics* (${mode})
Date: ${data.date}

Trades: ${data.tradesCount} (${data.wins}W / ${data.losses}L)
Win Rate: ${(data.winRate * 100).toFixed(0)}%
${pnlEmoji} P&L: ${data.pnlUsdc >= 0 ? '+' : ''}${data.pnlUsdc.toFixed(2)} (${data.pnlR >= 0 ? '+' : ''}${data.pnlR.toFixed(2)}R)
Avg R: ${data.avgR >= 0 ? '+' : ''}${data.avgR.toFixed(2)}
Max DD: ${data.maxDrawdown.toFixed(2)}
    `;

    await this.sendMessage(message, { parse_mode: 'Markdown' });
  }

  async sendRecentTrades(
    trades: Array<{
      symbol: string;
      side: string;
      pnlUsdc: number;
      pnlR: number;
      result: string;
      closedAt: number;
    }>,
    simulation?: boolean,
  ): Promise<void> {
    if (trades.length === 0) {
      await this.sendMessage('No trades yet');
      return;
    }

    const mode = simulation ? '🎮 SIM' : '💰 LIVE';
    let message = `📜 *Recent Trades* (${mode})\n\n`;

    for (const trade of trades) {
      const emoji =
        trade.result === 'WIN' ? '✅' : trade.result === 'LOSS' ? '❌' : '➖';
      const time = new Date(trade.closedAt).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
      });
      message += `${emoji} ${trade.symbol} ${trade.side}\n`;
      message += `   ${trade.pnlUsdc >= 0 ? '+' : ''}${trade.pnlUsdc.toFixed(2)} (${trade.pnlR >= 0 ? '+' : ''}${trade.pnlR.toFixed(2)}R) @ ${time}\n`;
    }

    await this.sendMessage(message, { parse_mode: 'Markdown' });
  }
}
