import { injectable, inject } from 'tsyringe';
import dayjs from 'dayjs';
import TelegramBot from 'node-telegram-bot-api';

import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { EventBus } from '../../infra/event-bus/event-bus';
import { EventHandler, setupEventHandlers } from '../../infra/event-bus/event-bus.decorators';
import { RetryUtils } from '../../infra/utils';
import type { EventData } from '../../infra/event-bus/event-bus.types';

@injectable()
export class TelegramService {
  private readonly bot: TelegramBot | null = null;
  private readonly adminChatId: string;
  private readonly logger: ILogger;
  private lastPositionsMessageId: number | null = null;

  private readonly MENU_BTNS = {
    POSITIONS: '📈 Positions',
    CLOSE_ALL: '⚠️ Close All',
    STOP_TRADING: '⏹️ Stop Trading',
    GET_BALANCES: '💰 Get balances',
    START_TRADING: '▶️ Start Trading',
  };

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private readonly config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private readonly eventBus: EventBus
  ) {
    this.logger = logger.child('Telegram');
    this.adminChatId = this.config.telegram.adminChatId;

    if (this.config.telegram.botToken) {
      try {
        this.bot = new TelegramBot(this.config.telegram.botToken, { polling: true });
        this.setupCommandHandlers();
        this.logger.info('Telegram bot initialized successfully');
      } catch (error) {
        this.logger.error('Failed to initialize Telegram bot:', error as Error);
        this.bot = null;
      }
    } else {
      this.logger.warn('Telegram service is disabled - bot token is missing');
    }

    // Setup event handlers for receiving responses
    setupEventHandlers(this);
  }

  /**
   * Checks if the sender is the owner of the bot
   */
  private isOwner(msg: TelegramBot.Message): boolean {
    return msg.chat?.id.toString() === this.adminChatId;
  }

  /**
   * Handles unauthorized requests
   */
  private handleUnauthorized(chatId: number): void {
    this.logger.warn(`Unauthorized access attempt from chat ID: ${chatId}`);
  }

  /**
   * Creates main menu keyboard
   */
  private getMainMenuKeyboard(): TelegramBot.ReplyKeyboardMarkup {
    return {
      keyboard: [
        [{ text: this.MENU_BTNS.POSITIONS }, { text: this.MENU_BTNS.GET_BALANCES }],
        [{ text: this.MENU_BTNS.STOP_TRADING }, { text: this.MENU_BTNS.START_TRADING }],
        [{ text: this.MENU_BTNS.CLOSE_ALL }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    };
  }

  /**
   * Creates inline confirmation keyboard
   */
  private getConfirmationKeyboard(action: string): TelegramBot.InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [
          { text: '✅ Confirm', callback_data: `confirm_${action}` },
          { text: '❌ Cancel', callback_data: 'cancel' },
        ],
      ],
    };
  }

  private setupCommandHandlers(): void {
    if (!this.bot) return;

    // Global authorization check
    this.bot.on('message', msg => {
      if (!this.isOwner(msg)) {
        this.handleUnauthorized(msg.chat.id);
        return;
      }
    });

    // Command /start or /menu - show main menu
    this.bot.onText(/\/(start|menu)/, async msg => {
      if (!this.isOwner(msg)) return;

      await this.bot?.sendMessage(
        this.adminChatId,
        '🤖 *Hedged LP Bot*\n\nMenu is ready. Use the buttons below.',
        {
          parse_mode: 'Markdown',
          reply_markup: this.getMainMenuKeyboard(),
        }
      );
    });

    // Command /help
    this.bot.onText(/\/help/i, async msg => {
      if (!this.isOwner(msg)) return;

      const helpMessage = [
        '📚 *Available Commands*',
        '',
        '📊 *Positions & Balances:*',
        '  /positions - View LP and hedge positions',
        '  /balances - View wallet balances',
        '',
        '🔧 *Trading Control:*',
        '  /stop - Stop automated trading',
        '  /start - Start automated trading',
        '  /close - Close all positions (with confirmation)',
        '',
        '🎛️ *Menu Buttons:*',
        '  📈 Positions - View LP & hedge status',
        '  💰 Get balances - View wallet balances',
        '  ⏹️ Stop Trading - Pause bot',
        '  ▶️ Start Trading - Resume bot',
        '  ⚠️ Close All - Emergency close all',
      ].join('\n');

      await this.bot?.sendMessage(this.adminChatId, helpMessage, {
        parse_mode: 'Markdown',
        reply_markup: this.getMainMenuKeyboard(),
      });
    });

    // Handle menu button clicks
    this.bot.on('message', async msg => {
      if (!this.isOwner(msg) || !msg.text) return;

      const text = msg.text;
      const isMenuButton = Object.values(this.MENU_BTNS).includes(text);

      if (isMenuButton) {
        // Delete button message to keep chat clean
        try {
          await this.bot?.deleteMessage(this.adminChatId, msg.message_id);
        } catch {
          // Ignore delete errors
        }
      }

      switch (text) {
        case this.MENU_BTNS.POSITIONS:
          this.handlePositionsCommand();
          break;
        case this.MENU_BTNS.CLOSE_ALL:
          this.handleCloseAllCommand();
          break;
        case this.MENU_BTNS.STOP_TRADING:
          this.handleStopTradingCommand();
          break;
        case this.MENU_BTNS.START_TRADING:
          this.handleStartTradingCommand();
          break;
        case this.MENU_BTNS.GET_BALANCES:
          this.handleBalancesCommand();
          break;
      }
    });

    // Handle inline button callbacks
    this.bot.on('callback_query', async query => {
      if (!query.message || !this.isOwner(query.message as TelegramBot.Message)) {
        await this.bot?.answerCallbackQuery(query.id, { text: '⛔ Unauthorized' });
        return;
      }

      const action = query.data;

      switch (action) {
        case 'confirm_close_all':
          await this.bot?.answerCallbackQuery(query.id, { text: '✅ Closing all positions...' });
          await this.bot?.sendMessage(this.adminChatId, '⏳ Closing LP and hedge positions...');
          this.eventBus.emit('positions.close-all.request', {
            source: 'telegram',
            timestamp: Date.now(),
          });
          break;

        case 'confirm_stop_trading':
          await this.bot?.answerCallbackQuery(query.id, { text: '✅ Stopping trading...' });
          this.config.simulation.enabled = true;
          await this.bot?.sendMessage(this.adminChatId, '🛑 Trading stopped (simulation mode ON)');
          break;

        case 'confirm_start_trading':
          await this.bot?.answerCallbackQuery(query.id, { text: '✅ Starting trading...' });
          this.config.simulation.enabled = false;
          await this.bot?.sendMessage(this.adminChatId, '🟢 Trading started (simulation mode OFF)');
          break;

        case 'cancel':
          await this.bot?.answerCallbackQuery(query.id, { text: '❌ Cancelled' });
          await this.bot?.sendMessage(this.adminChatId, '❌ Action cancelled');
          break;
      }

      // Remove inline buttons after click
      if (query.message) {
        await this.bot?.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
          }
        );
      }
    });

    // Command shortcuts
    this.bot.onText(/\/positions/, () => this.handlePositionsCommand());
    this.bot.onText(/\/balances/, () => this.handleBalancesCommand());
    this.bot.onText(/\/close/, () => this.handleCloseAllCommand());
    this.bot.onText(/\/stop/, () => this.handleStopTradingCommand());
  }

  // ==================== Command Handlers ====================

  private handlePositionsCommand(): void {
    this.eventBus.emit('positions.current.request', {
      source: 'telegram',
      timestamp: Date.now(),
    });
  }

  private handleBalancesCommand(): void {
    this.eventBus.emit('balances.get.request', { source: 'telegram' });
  }

  private handleCloseAllCommand(): void {
    this.bot?.sendMessage(
      this.adminChatId,
      '⚠️ *Close All Positions*\n\nAre you sure you want to close LP and hedge positions?',
      {
        parse_mode: 'Markdown',
        reply_markup: this.getConfirmationKeyboard('close_all'),
      }
    );
  }

  private handleStopTradingCommand(): void {
    this.bot?.sendMessage(
      this.adminChatId,
      '🛑 *Stop Trading*\n\nAre you sure you want to stop trading activity?',
      {
        parse_mode: 'Markdown',
        reply_markup: this.getConfirmationKeyboard('stop_trading'),
      }
    );
  }

  private handleStartTradingCommand(): void {
    this.bot?.sendMessage(
      this.adminChatId,
      '🟢 *Start Trading*\n\nAre you sure you want to start trading activity?',
      {
        parse_mode: 'Markdown',
        reply_markup: this.getConfirmationKeyboard('start_trading'),
      }
    );
  }

  // ==================== Event Handlers ====================

  @EventHandler('positions.current.response')
  async handlePositionsResponse(data: EventData<'positions.current.response'>): Promise<void> {
    if (data.error) {
      await this.sendMessage(`❌ Error getting positions: ${data.error}`);
      return;
    }

    const userTz = this.config.userTz;
    const timestamp = dayjs(data.timestamp).tz(userTz).format('HH:mm:ss');
    const lines: string[] = [];

    lines.push(`📊 *Current Positions*`);
    lines.push(`🕐 ${timestamp}`);
    lines.push(`💱 Price: $${data.referencePrice}`);
    lines.push('');

    // LP Position
    if (data.lp) {
      const rangeStatus = data.lp.inRange ? '🟢 In Range' : '🔴 Out of Range';
      lines.push(`*📈 LP Position* (ID: ${data.lp.tokenId})`);
      lines.push(`${rangeStatus}`);
      lines.push(`├ WETH: ${data.lp.wethAmount} (${data.lp.wethPercent}%)`);
      lines.push(`├ USDC: $${data.lp.usdcAmount} (${data.lp.usdcPercent}%)`);
      lines.push(`├ Total: *$${data.lp.totalValueUsdc}*`);
      lines.push(`├ Range: $${data.lp.priceLower} - $${data.lp.priceUpper}`);
      lines.push(`└ Distance: ↓${data.lp.distanceToLowerPercent}% ↑${data.lp.distanceToUpperPercent}%`);
    } else {
      lines.push(`*📈 LP Position*: ❌ No active position`);
    }

    lines.push('');

    // Hedge Position
    if (data.hedge) {
      const pnlSign = parseFloat(data.hedge.unrealizedPnl) >= 0 ? '+' : '';
      const pnlEmoji = parseFloat(data.hedge.unrealizedPnl) >= 0 ? '🟢' : '🔴';
      lines.push(`*🔻 Hedge (Short)*`);
      lines.push(`├ Size: ${data.hedge.shortSizeEth} ETH ($${data.hedge.shortNotionalUsdc})`);
      lines.push(`├ Entry: $${data.hedge.entryPrice} | Mark: $${data.hedge.markPrice}`);
      lines.push(`├ PnL: ${pnlEmoji} ${pnlSign}$${data.hedge.unrealizedPnl}`);
      lines.push(`├ Leverage: ${data.hedge.leverage}x`);
      lines.push(`├ Equity: $${data.hedge.equity}`);
      lines.push(`├ Available: $${data.hedge.availableBalance}`);
      lines.push(`├ Margin: ${data.hedge.marginRatioPercent}%`);
      lines.push(`└ Liq: $${data.hedge.liquidationPrice} (${data.hedge.liquidationDistancePercent}% away)`);
    } else {
      lines.push(`*🔻 Hedge*: ❌ No position`);
    }

    lines.push('');
    lines.push(`📐 Hedge Ratio: *${data.hedgeRatio}%*`);

    await this.sendPositionsMessage(lines.join('\n'));
  }

  // ==================== Send Methods ====================

  async sendMessage(message: string): Promise<boolean> {
    if (!this.bot) {
      this.logger.warn('Telegram service is not available');
      return false;
    }

    try {
      await RetryUtils.retry(() => this.bot!.sendMessage(this.adminChatId, message), {
        maxRetries: 3,
        baseDelay: 1000,
      });
      return true;
    } catch (error) {
      this.logger.error('Failed to send Telegram message:', error as Error);
      return false;
    }
  }

  async sendMessageWithMarkdown(message: string): Promise<boolean> {
    if (!this.bot) {
      this.logger.warn('Telegram service is not available');
      return false;
    }

    try {
      await RetryUtils.retry(
        () => this.bot!.sendMessage(this.adminChatId, message, { parse_mode: 'Markdown' }),
        { maxRetries: 3, baseDelay: 1000 }
      );
      return true;
    } catch (error) {
      this.logger.error('Failed to send Telegram message with Markdown:', error as Error);
      return false;
    }
  }

  async sendMessageWithHTML(message: string): Promise<boolean> {
    if (!this.bot) {
      this.logger.warn('Telegram service is not available');
      return false;
    }

    try {
      await RetryUtils.retry(
        () => this.bot!.sendMessage(this.adminChatId, message, { parse_mode: 'HTML' }),
        { maxRetries: 3, baseDelay: 1000 }
      );
      return true;
    } catch (error) {
      this.logger.error('Failed to send Telegram message with HTML:', error as Error);
      return false;
    }
  }

  /**
   * Send positions message, deleting previous one if exists
   */
  private async sendPositionsMessage(message: string): Promise<void> {
    if (!this.bot) return;

    // Delete previous positions message
    if (this.lastPositionsMessageId !== null) {
      try {
        await this.bot.deleteMessage(this.adminChatId, this.lastPositionsMessageId);
      } catch {
        // Ignore delete errors
      }
    }

    try {
      const sentMessage = await RetryUtils.retry(
        () =>
          this.bot!.sendMessage(this.adminChatId, message, {
            parse_mode: 'Markdown',
            reply_markup: this.getMainMenuKeyboard(),
          }),
        { maxRetries: 3, baseDelay: 1000 }
      );
      this.lastPositionsMessageId = sentMessage.message_id;
    } catch (error) {
      this.logger.error('Failed to send positions message:', error as Error);
    }
  }

  async sendBalancesMessage(message: string): Promise<boolean> {
    if (!this.bot) {
      this.logger.warn('Telegram service is not available');
      return false;
    }

    try {
      await RetryUtils.retry(
        () =>
          this.bot!.sendMessage(this.adminChatId, message, {
            parse_mode: 'Markdown',
            reply_markup: this.getMainMenuKeyboard(),
          }),
        { maxRetries: 3, baseDelay: 1000 }
      );
      return true;
    } catch (error) {
      this.logger.error('Failed to send balances message:', error as Error);
      return false;
    }
  }
}
