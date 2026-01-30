import { inject, injectable } from 'tsyringe';
import { ConfigService } from './config';
import { Logger, ILogger } from './infra/logger/logger';
import { EventBus } from './infra/event-bus/event-bus';
import { SchedulerService } from './infra/scheduler/scheduler';
import {
  setupEventHandlers,
  EventHandler,
} from './infra/event-bus/event-bus.decorators';
import { TOKENS } from './di/tokens';

// Integrations
import { BinanceClient } from './integrations/exchanges/binance/binance';
import { RedisClient } from './integrations/database/redis-client';
import { MongoDBClient } from './integrations/database/mongo-client';
import { TelegramService } from './integrations/telegram/telegram.service';

// Domain Services
import { MarketDataService } from './domain/market-data/market-data.service';
import { FeatureBuilder } from './domain/features/features.service';
import { DataIntegrityGuard } from './domain/data-integrity/data-integrity.service';
import { LiqBurstDetector } from './domain/detectors/liq-burst.detector';
import { CrowdingDetector } from './domain/detectors/crowding.detector';
import { SignalClassifier } from './domain/classifier/classifier.service';
import { SetupEngine } from './domain/setup-engine/setup-engine.service';
import { ExecutionEngine } from './domain/execution/execution.service';
import { RiskManager } from './domain/risk/risk.service';
import { JournalService } from './domain/journal/journal.service';

@injectable()
export class App {
  private readonly logger: ILogger;
  private isRunning = false;

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
    @inject(TOKENS.SCHEDULER_SERVICE) private scheduler: SchedulerService,

    // Integrations
    @inject(TOKENS.BINANCE_CLIENT) private binance: BinanceClient,
    @inject(TOKENS.REDIS_CLIENT) private redis: RedisClient,
    @inject(TOKENS.MONGO_CLIENT) private mongo: MongoDBClient,
    @inject(TOKENS.TELEGRAM_SERVICE) private telegram: TelegramService,

    // Domain Services
    @inject(TOKENS.MARKET_DATA_SERVICE) private marketData: MarketDataService,
    @inject(TOKENS.FEATURE_BUILDER) private featureBuilder: FeatureBuilder,
    @inject(TOKENS.DATA_INTEGRITY_GUARD)
    private dataIntegrity: DataIntegrityGuard,
    @inject(TOKENS.LIQ_BURST_DETECTOR)
    private liqBurstDetector: LiqBurstDetector,
    @inject(TOKENS.CROWDING_DETECTOR)
    private crowdingDetector: CrowdingDetector,
    @inject(TOKENS.SIGNAL_CLASSIFIER)
    private signalClassifier: SignalClassifier,
    @inject(TOKENS.SETUP_ENGINE) private setupEngine: SetupEngine,
    @inject(TOKENS.EXECUTION_ENGINE) private executionEngine: ExecutionEngine,
    @inject(TOKENS.RISK_MANAGER) private riskManager: RiskManager,
    @inject(TOKENS.JOURNAL_SERVICE) private journal: JournalService,
  ) {
    this.logger = logger.child('App');
    setupEventHandlers(this);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Application is already running');
      return;
    }

    const mode = this.config.isSimulation() ? '🎮 SIMULATION' : '💰 LIVE';

    this.logger.info('═══════════════════════════════════════════');
    this.logger.info('     FFE Trading Bot - Starting Up');
    this.logger.info('═══════════════════════════════════════════');
    this.logger.info(`Mode: ${mode}`);
    this.logger.info(`Environment: ${this.config.nodeEnv}`);
    this.logger.info(`Symbols: ${this.config.symbols.join(', ')}`);
    this.logger.info(`Testnet: ${this.config.exchange.testnet}`);
    this.logger.info('═══════════════════════════════════════════');

    try {
      // 1. Connect to external services
      this.logger.info('Connecting to external services...');

      await this.mongo.connect();
      this.logger.info('✓ MongoDB connected');

      await this.redis.connect();
      this.logger.info('✓ Redis connected');

      await this.binance.connect();
      this.logger.info('✓ Binance connected');

      // 2. Start infrastructure services
      this.logger.info('Starting infrastructure services...');
      await this.scheduler.start();

      // 3. Start domain services
      this.logger.info('Starting domain services...');

      await this.riskManager.start();
      this.logger.info('✓ RiskManager started');

      await this.journal.start();
      this.logger.info('✓ JournalService started');

      await this.marketData.start();
      this.logger.info('✓ MarketDataService started');

      await this.featureBuilder.start();
      this.logger.info('✓ FeatureBuilder started');

      await this.dataIntegrity.start();
      this.logger.info('✓ DataIntegrityGuard started');

      await this.setupEngine.start();
      this.logger.info('✓ SetupEngine started');

      await this.executionEngine.start();
      this.logger.info('✓ ExecutionEngine started');

      // 4. Start Telegram bot
      await this.telegram.start();
      this.logger.info('✓ TelegramService started');

      // 5. Setup scheduled tasks
      this.setupScheduledTasks();

      this.isRunning = true;

      // Emit system started event
      this.eventBus.emit('system.started', {
        timestamp: Date.now(),
        symbols: this.config.symbols,
        mode: this.config.isSimulation() ? 'PAPER' : 'LIVE',
      });

      this.logger.info('═══════════════════════════════════════════');
      this.logger.info(`     FFE Trading Bot - Running (${mode})`);
      this.logger.info('═══════════════════════════════════════════');
    } catch (error) {
      this.logger.error('Failed to start application', error as Error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping FFE Trading Bot...');

    try {
      // Stop in reverse order

      // Stop domain services
      await this.executionEngine.stop();
      await this.setupEngine.stop();
      await this.dataIntegrity.stop();
      await this.marketData.stop();

      // Stop infrastructure
      await this.scheduler.stop();
      await this.telegram.stop();

      // Disconnect external services
      await this.binance.disconnect();
      await this.redis.disconnect();
      await this.mongo.disconnect();

      this.isRunning = false;

      this.eventBus.emit('system.stopped', {
        timestamp: Date.now(),
        reason: 'graceful_shutdown',
      });

      this.logger.info('FFE Trading Bot stopped');
    } catch (error) {
      this.logger.error('Error during shutdown', error as Error);
    }
  }

  private setupScheduledTasks(): void {
    // Update equity every 5 minutes (skip in simulation)
    this.scheduler.scheduleJob('update-equity', '*/5 * * * *', async () => {
      await this.riskManager.updateEquity();
    });

    // Log hourly stats
    this.scheduler.scheduleJob('hourly-stats', '0 * * * *', async () => {
      const metrics = this.journal.getDailyMetrics();
      const overall = this.journal.getOverallStats();
      const mode = this.config.isSimulation() ? '[SIM]' : '[LIVE]';

      this.logger.info(`${mode} Hourly Stats`, {
        todayTrades: metrics.tradesCount,
        todayPnl: metrics.pnlUsdc.toFixed(2),
        todayWinRate: (metrics.winRate * 100).toFixed(0) + '%',
        totalTrades: overall.totalTrades,
        totalPnl: overall.totalPnlUsdc.toFixed(2),
      });
    });

    // Log daily summary at midnight UTC
    this.scheduler.scheduleJob('daily-summary', '0 0 * * *', async () => {
      const metrics = this.journal.getDailyMetrics();
      const mode = this.config.isSimulation() ? '🎮 SIM' : '💰 LIVE';

      this.logger.info('Daily Summary', metrics);

      await this.telegram.sendDailyMetrics({
        ...metrics,
        simulation: this.config.isSimulation(),
      });
    });
  }

  // ==================== Event Handlers ====================

  @EventHandler('telegram.positions.request')
  async onPositionsRequest(): Promise<void> {
    const positions = this.executionEngine.getAllPositions();
    const armedPlans = this.executionEngine.getArmedPlans();
    const riskStats = this.riskManager.getDailyStats();
    const equity = this.riskManager.getEquity();
    const metrics = this.journal.getDailyMetrics();

    await this.telegram.sendStatusUpdate({
      activePositions: positions.length,
      pendingPlans: armedPlans.length,
      dailyPnl: riskStats.pnlUsdc,
      equity,
      winRate: metrics.winRate,
      tradesCount: metrics.tradesCount,
      simulation: this.config.isSimulation(),
    });
  }

  @EventHandler('telegram.metrics.request')
  async onMetricsRequest(): Promise<void> {
    const metrics = this.journal.getDailyMetrics();

    await this.telegram.sendDailyMetrics({
      ...metrics,
      simulation: this.config.isSimulation(),
    });
  }

  @EventHandler('telegram.stats.request')
  async onStatsRequest(): Promise<void> {
    const overall = this.journal.getOverallStats();

    await this.telegram.sendOverallStats({
      ...overall,
      simulation: this.config.isSimulation(),
    });
  }

  @EventHandler('telegram.trades.request')
  async onTradesRequest(): Promise<void> {
    const trades = this.journal.getRecentTrades(5);

    await this.telegram.sendRecentTrades(
      trades.map((t) => ({
        symbol: t.symbol,
        side: t.side,
        pnlUsdc: t.pnlUsdc,
        pnlR: t.pnlR,
        result: t.result,
        closedAt: t.closedAt,
      })),
      this.config.isSimulation(),
    );
  }

  @EventHandler('telegram.kill-switch.request')
  async onKillSwitchRequest(): Promise<void> {
    this.logger.warn('Kill switch requested via Telegram');
    await this.executionEngine.activateKillSwitch();
  }

  @EventHandler('trade-plan.created')
  onPlanCreated(plan: any): void {
    // Apply position sizing from RiskManager
    this.riskManager.sizePlan(plan);
  }

  // ==================== Getters ====================

  isAppRunning(): boolean {
    return this.isRunning;
  }
}
