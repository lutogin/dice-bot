export const TOKENS = {
  // Core Infrastructure
  CONFIG_SERVICE: Symbol.for('ConfigService'),
  LOGGER: Symbol.for('Logger'),
  EVENT_BUS: Symbol.for('EventBus'),
  SCHEDULER_SERVICE: Symbol.for('SchedulerService'),

  // Communication
  TELEGRAM_SERVICE: Symbol.for('TelegramService'),

  // Database
  REDIS_CLIENT: Symbol.for('RedisClient'),
  MONGO_CLIENT: Symbol.for('MongoDBClient'),

  // Repositories
  FORCED_EVENTS_REPO: Symbol.for('ForcedEventsRepository'),
  TRADE_PLANS_REPO: Symbol.for('TradePlansRepository'),
  TRADES_REPO: Symbol.for('TradesRepository'),

  // Exchange
  BINANCE_CLIENT: Symbol.for('BinanceClient'),

  // Market Data
  MARKET_DATA_SERVICE: Symbol.for('MarketDataService'),

  // Features
  FEATURE_BUILDER: Symbol.for('FeatureBuilder'),

  // Data Integrity
  DATA_INTEGRITY_GUARD: Symbol.for('DataIntegrityGuard'),

  // Detectors
  LIQ_BURST_DETECTOR: Symbol.for('LiqBurstDetector'),
  CROWDING_DETECTOR: Symbol.for('CrowdingDetector'),

  // Signal Processing
  SIGNAL_CLASSIFIER: Symbol.for('SignalClassifier'),

  // Trade Management
  SETUP_ENGINE: Symbol.for('SetupEngine'),
  EXECUTION_ENGINE: Symbol.for('ExecutionEngine'),
  RISK_MANAGER: Symbol.for('RiskManager'),

  // Journal
  JOURNAL_SERVICE: Symbol.for('JournalService'),

  // Application
  APP: Symbol.for('App'),
} as const;
