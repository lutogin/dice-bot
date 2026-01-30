export const TOKENS = {

  // Core domain
  CONFIG_SERVICE: Symbol.for('ConfigService'),
  LOGGER: Symbol.for('Logger'),
  EVENT_BUS: Symbol.for('EventBus'),
  SCHEDULER_SERVICE: Symbol.for('SchedulerService'),

  // Communication
  TELEGRAM_SERVICE: Symbol.for('TelegramService'),
  COMMUNICATOR_SERVICE: Symbol.for('CommunicatorService'),

  // Database
  MONGO_CLIENT: Symbol.for('MongoClient'),
  STATE_STORE_REPOSITORY: Symbol.for('StateStoreRepository'),

  // LP Position Management (Uniswap v3)
  LP_POSITION_SERVICE: Symbol.for('LpPositionService'),

  // Hedge Management (CEX Perps)
  HEDGE_SERVICE: Symbol.for('HedgeService'),
  BINANCE_CLIENT: Symbol.for('BinanceClient'),

  // Strategy Engine
  STRATEGY_ENGINE: Symbol.for('StrategyEngine'),

  // Execution Orchestrator
  EXECUTION_ORCHESTRATOR: Symbol.for('ExecutionOrchestrator'),

  // Risk Manager
  RISK_MANAGER: Symbol.for('RiskManager'),

  // Price Service
  PRICE_SERVICE: Symbol.for('PriceService'),

  // Monitoring Service
  MONITORING_SERVICE: Symbol.for('MonitoringService'),

  // Transaction Policy Service
  TX_POLICY_SERVICE: Symbol.for('TxPolicyService'),

  // Wallet Service
  WALLET_SERVICE: Symbol.for('WalletService'),

  // Ledger Service
  LEDGER_SERVICE: Symbol.for('LedgerService'),

  // State Store
  STATE_STORE: Symbol.for('StateStore'),

  // Range Model Service
  RANGE_MODEL_SERVICE: Symbol.for('RangeModelService'),

  // Dynamic Threshold Service
  DYNAMIC_THRESHOLD_SERVICE: Symbol.for('DynamicThresholdService'),

  // Rehedge Decision Service
  REHEDGE_DECISION_SERVICE: Symbol.for('RehedgeDecisionService'),

  // Application
  APP: Symbol.for('App'),
} as const;
