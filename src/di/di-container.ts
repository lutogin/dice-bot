import { container } from 'tsyringe';
import { TOKENS } from './tokens';

// Config
import { ConfigService } from '../config';

// Infrastructure
import { Logger } from '../infra/logger/logger';
import { EventBus } from '../infra/event-bus/event-bus';
import { SchedulerService } from '../infra/scheduler/scheduler';

// Integrations
import { BinanceClient } from '../integrations/exchanges/binance/binance';
import { TelegramService } from '../integrations/telegram/telegram.service';
import { RedisClient } from '../integrations/database/redis-client';
import { MongoDBClient } from '../integrations/database/mongo-client';
import {
  ForcedEventsRepository,
  TradePlansRepository,
  TradesRepository,
} from '../integrations/database/repositories';

// Domain - Market Data
import { MarketDataService } from '../domain/market-data/market-data.service';

// Domain - Features
import { FeatureBuilder } from '../domain/features/features.service';

// Domain - Detectors
import { LiqBurstDetector } from '../domain/detectors/liq-burst.detector';
import { CrowdingDetector } from '../domain/detectors/crowding.detector';

// Domain - Signal Processing
import { SignalClassifier } from '../domain/classifier/classifier.service';

// Domain - Trade Management
import { SetupEngine } from '../domain/setup-engine/setup-engine.service';
import { ExecutionEngine } from '../domain/execution/execution.service';
import { RiskManager } from '../domain/risk/risk.service';

// Domain - Journal
import { JournalService } from '../domain/journal/journal.service';

// Application
import { App } from '../app';

export class DIContainer {
  private static instance: DIContainer;
  private isConfigured = false;

  private constructor() {}

  public static getInstance(): DIContainer {
    if (!DIContainer.instance) {
      DIContainer.instance = new DIContainer();
    }
    return DIContainer.instance;
  }

  public configure(): void {
    if (this.isConfigured) {
      return;
    }

    // ==================== Core Infrastructure ====================
    container.registerSingleton(TOKENS.CONFIG_SERVICE, ConfigService);
    container.registerSingleton(TOKENS.LOGGER, Logger);
    container.registerSingleton(TOKENS.EVENT_BUS, EventBus);
    container.registerSingleton(TOKENS.SCHEDULER_SERVICE, SchedulerService);

    // ==================== Integrations ====================
    container.registerSingleton(TOKENS.TELEGRAM_SERVICE, TelegramService);
    container.registerSingleton(TOKENS.REDIS_CLIENT, RedisClient);
    container.registerSingleton(TOKENS.MONGO_CLIENT, MongoDBClient);
    container.registerSingleton(TOKENS.BINANCE_CLIENT, BinanceClient);

    // ==================== Repositories ====================
    container.registerSingleton(
      TOKENS.FORCED_EVENTS_REPO,
      ForcedEventsRepository,
    );
    container.registerSingleton(TOKENS.TRADE_PLANS_REPO, TradePlansRepository);
    container.registerSingleton(TOKENS.TRADES_REPO, TradesRepository);

    // ==================== Domain - Market Data ====================
    container.registerSingleton(TOKENS.MARKET_DATA_SERVICE, MarketDataService);

    // ==================== Domain - Features ====================
    container.registerSingleton(TOKENS.FEATURE_BUILDER, FeatureBuilder);

    // ==================== Domain - Detectors ====================
    container.registerSingleton(TOKENS.LIQ_BURST_DETECTOR, LiqBurstDetector);
    container.registerSingleton(TOKENS.CROWDING_DETECTOR, CrowdingDetector);

    // ==================== Domain - Signal Processing ====================
    container.registerSingleton(TOKENS.SIGNAL_CLASSIFIER, SignalClassifier);

    // ==================== Domain - Trade Management ====================
    container.registerSingleton(TOKENS.SETUP_ENGINE, SetupEngine);
    container.registerSingleton(TOKENS.EXECUTION_ENGINE, ExecutionEngine);
    container.registerSingleton(TOKENS.RISK_MANAGER, RiskManager);

    // ==================== Domain - Journal ====================
    container.registerSingleton(TOKENS.JOURNAL_SERVICE, JournalService);

    // ==================== Application ====================
    container.registerSingleton(App);

    this.isConfigured = true;
  }

  public getContainer(): typeof container {
    if (!this.isConfigured) {
      this.configure();
    }
    return container;
  }

  public resolve<T>(token: symbol | (new (...args: any[]) => T)): T {
    return this.getContainer().resolve<T>(token as any);
  }
}

export const diContainer = DIContainer.getInstance();
