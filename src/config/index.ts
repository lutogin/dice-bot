import dotenv from 'dotenv';
import { injectable } from 'tsyringe';
import Joi from 'joi';

dotenv.config();

export interface FFEConfig {
  nodeEnv: string;
  logLevel: string;
  simulation: boolean; // Paper trading mode

  // Trading symbols
  symbols: string[];

  // Telegram
  telegram: {
    botToken: string;
    adminChatId: string;
  };

  // Binance Exchange
  exchange: {
    apiKey: string;
    secret: string;
    testnet: boolean;
  };

  // Redis
  redis: {
    url: string;
  };

  // MongoDB
  mongo: {
    url: string;
    dbName: string;
  };

  // Liquidation Burst Detector
  liqBurst: {
    minRet30sPct: number;
    kMedian: number;
    minLiqNotionalAbs: number;
    cooldownSec: number;
  };

  // Stall/Absorption Setup
  stall: {
    maxStallRangePct: number;
    minReplenishScore: number;
    waitMinSec: number;
    waitMaxSec: number;
    breakoutBuffer: number;
  };

  // Risk Management
  risk: {
    maxRiskPerTrade: number;
    minRiskPerTrade: number;
    maxConcurrentPositions: number;
    dailyLossLimit: number;
    maxNotionalPerTrade: number;
  };

  // Take Profit / Stop Loss
  exits: {
    tp1MultR: number;
    tp1ClosePct: number;
    tp2MultR: number;
    trailActivateR: number;
    stopBuffer: number;
  };

  // Feature Windows
  features: {
    oiPollIntervalSec: number;
    fundingPollIntervalSec: number;
  };

  // OI Crowding Detector
  crowding: {
    minOiChangePct: number; // Minimum OI increase to trigger (e.g., 0.05 = 5%)
    oiLookbackMinutes: number; // How far back to measure OI change
    fundingExtremeThreshold: number; // Funding rate threshold (e.g., 0.0005 = 0.05%)
    maxStallRangePct: number; // Price must be stalling
    cooldownSec: number;
  };

  // Data Integrity Guard
  dataIntegrity: {
    maxTickGapMs: number; // Max time without tick before stale
    maxBookGapMs: number; // Max time without book update before stale
    maxOiAgeMs: number; // Max OI data age
    maxSpreadPct: number; // Max spread before unhealthy
    minTopDepthUsd: number; // Min depth on each side
    minTrades10s: number; // Min trades per 10s
    maxReconnects5min: number; // Max WS reconnects per 5 min
    startupGracePeriodMs: number; // Grace period on startup
  };
}

const configSchema = Joi.object({
  nodeEnv: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  logLevel: Joi.string()
    .valid('error', 'warn', 'info', 'debug')
    .default('info'),
  simulation: Joi.boolean().default(false),

  symbols: Joi.array().items(Joi.string()).min(1).required(),

  telegram: Joi.object({
    botToken: Joi.string().allow('').default(''),
    adminChatId: Joi.string().allow('').default(''),
  }),

  exchange: Joi.object({
    apiKey: Joi.string().allow('').default(''),
    secret: Joi.string().allow('').default(''),
    testnet: Joi.boolean().default(true),
  }),

  redis: Joi.object({
    url: Joi.string().default('redis://localhost:6379'),
  }),

  mongo: Joi.object({
    url: Joi.string().default('mongodb://localhost:27017'),
    dbName: Joi.string().default('ffe_bot'),
  }),

  liqBurst: Joi.object({
    minRet30sPct: Joi.number().default(0.006),
    kMedian: Joi.number().default(8),
    minLiqNotionalAbs: Joi.number().default(10_000_000),
    cooldownSec: Joi.number().default(60),
  }),

  stall: Joi.object({
    maxStallRangePct: Joi.number().default(0.0012),
    minReplenishScore: Joi.number().default(0.6),
    waitMinSec: Joi.number().default(30),
    waitMaxSec: Joi.number().default(300),
    breakoutBuffer: Joi.number().default(0.0005),
  }),

  risk: Joi.object({
    maxRiskPerTrade: Joi.number().default(0.005),
    minRiskPerTrade: Joi.number().default(0.0025),
    maxConcurrentPositions: Joi.number().default(1),
    dailyLossLimit: Joi.number().default(0.015),
    maxNotionalPerTrade: Joi.number().default(15_000),
  }),

  exits: Joi.object({
    tp1MultR: Joi.number().default(1.0),
    tp1ClosePct: Joi.number().default(0.5),
    tp2MultR: Joi.number().default(2.0),
    trailActivateR: Joi.number().default(0.8),
    stopBuffer: Joi.number().default(0.001),
  }),

  features: Joi.object({
    oiPollIntervalSec: Joi.number().default(60),
    fundingPollIntervalSec: Joi.number().default(300),
  }),

  crowding: Joi.object({
    minOiChangePct: Joi.number().default(0.05), // 5% OI increase
    oiLookbackMinutes: Joi.number().default(30), // 30 min lookback
    fundingExtremeThreshold: Joi.number().default(0.0005), // 0.05% funding
    maxStallRangePct: Joi.number().default(0.002), // 0.2% price range
    cooldownSec: Joi.number().default(300), // 5 min cooldown
  }),

  dataIntegrity: Joi.object({
    maxTickGapMs: Joi.number().default(5000), // 5 sec
    maxBookGapMs: Joi.number().default(3000), // 3 sec
    maxOiAgeMs: Joi.number().default(300000), // 5 min
    maxSpreadPct: Joi.number().default(0.003), // 0.3%
    minTopDepthUsd: Joi.number().default(10000), // $10k
    minTrades10s: Joi.number().default(5), // 5 trades
    maxReconnects5min: Joi.number().default(3), // 3 reconnects
    startupGracePeriodMs: Joi.number().default(30000), // 30 sec
  }),
});

@injectable()
export class ConfigService implements FFEConfig {
  readonly nodeEnv: string;
  readonly logLevel: string;
  readonly simulation: boolean;
  readonly symbols: string[];
  readonly telegram: FFEConfig['telegram'];
  readonly exchange: FFEConfig['exchange'];
  readonly redis: FFEConfig['redis'];
  readonly mongo: FFEConfig['mongo'];
  readonly liqBurst: FFEConfig['liqBurst'];
  readonly stall: FFEConfig['stall'];
  readonly risk: FFEConfig['risk'];
  readonly exits: FFEConfig['exits'];
  readonly features: FFEConfig['features'];
  readonly crowding: FFEConfig['crowding'];
  readonly dataIntegrity: FFEConfig['dataIntegrity'];

  constructor() {
    const rawConfig = {
      nodeEnv: process.env['NODE_ENV'] || 'development',
      logLevel: process.env['LOG_LEVEL'] || 'info',
      simulation: process.env['FFE_SIMULATION'] === 'true',

      symbols: (process.env['FFE_SYMBOLS'] || 'ETH/USDT:USDT')
        .split(',')
        .map((s) => s.trim()),

      telegram: {
        botToken: process.env['TELEGRAM_BOT_TOKEN'] || '',
        adminChatId: process.env['TELEGRAM_ADMIN_CHAT_ID'] || '',
      },

      exchange: {
        apiKey: process.env['BINANCE_API_KEY'] || '',
        secret: process.env['BINANCE_SECRET'] || '',
        testnet: process.env['BINANCE_TESTNET'] === 'true',
      },

      redis: {
        url: process.env['REDIS_URL'] || 'redis://localhost:6379',
      },

      mongo: {
        url: process.env['MONGO_URL'] || 'mongodb://localhost:27017',
        dbName: process.env['MONGO_DB_NAME'] || 'ffe_bot',
      },

      liqBurst: {
        minRet30sPct: parseFloat(process.env['FFE_LIQ_MIN_RET_30S'] || '0.006'),
        kMedian: parseFloat(process.env['FFE_LIQ_K_MEDIAN'] || '8'),
        minLiqNotionalAbs: parseFloat(
          process.env['FFE_LIQ_MIN_NOTIONAL'] || '10000000',
        ),
        cooldownSec: parseInt(process.env['FFE_LIQ_COOLDOWN_SEC'] || '60', 10),
      },

      stall: {
        maxStallRangePct: parseFloat(
          process.env['FFE_STALL_MAX_RANGE_PCT'] || '0.0012',
        ),
        minReplenishScore: parseFloat(
          process.env['FFE_STALL_MIN_REPLENISH'] || '0.6',
        ),
        waitMinSec: parseInt(process.env['FFE_STALL_WAIT_MIN_SEC'] || '30', 10),
        waitMaxSec: parseInt(
          process.env['FFE_STALL_WAIT_MAX_SEC'] || '300',
          10,
        ),
        breakoutBuffer: parseFloat(
          process.env['FFE_STALL_BREAKOUT_BUFFER'] || '0.0005',
        ),
      },

      risk: {
        maxRiskPerTrade: parseFloat(
          process.env['FFE_RISK_PER_TRADE'] || '0.005',
        ),
        minRiskPerTrade: parseFloat(
          process.env['FFE_MIN_RISK_PER_TRADE'] || '0.0025',
        ),
        maxConcurrentPositions: parseInt(
          process.env['FFE_MAX_CONCURRENT'] || '1',
          10,
        ),
        dailyLossLimit: parseFloat(
          process.env['FFE_DAILY_LOSS_LIMIT'] || '0.015',
        ),
        maxNotionalPerTrade: parseFloat(
          process.env['FFE_MAX_NOTIONAL'] || '15000',
        ),
      },

      exits: {
        tp1MultR: parseFloat(process.env['FFE_TP1_MULT'] || '1.0'),
        tp1ClosePct: parseFloat(process.env['FFE_TP1_CLOSE_PCT'] || '0.5'),
        tp2MultR: parseFloat(process.env['FFE_TP2_MULT'] || '2.0'),
        trailActivateR: parseFloat(
          process.env['FFE_TRAIL_ACTIVATE_R'] || '0.8',
        ),
        stopBuffer: parseFloat(process.env['FFE_STOP_BUFFER'] || '0.001'),
      },

      features: {
        oiPollIntervalSec: parseInt(
          process.env['FFE_OI_POLL_INTERVAL_SEC'] || '60',
          10,
        ),
        fundingPollIntervalSec: parseInt(
          process.env['FFE_FUNDING_POLL_INTERVAL_SEC'] || '300',
          10,
        ),
      },

      crowding: {
        minOiChangePct: parseFloat(
          process.env['FFE_CROWDING_MIN_OI_CHANGE'] || '0.05',
        ),
        oiLookbackMinutes: parseInt(
          process.env['FFE_CROWDING_OI_LOOKBACK_MIN'] || '30',
          10,
        ),
        fundingExtremeThreshold: parseFloat(
          process.env['FFE_CROWDING_FUNDING_THRESHOLD'] || '0.0005',
        ),
        maxStallRangePct: parseFloat(
          process.env['FFE_CROWDING_MAX_STALL_RANGE'] || '0.002',
        ),
        cooldownSec: parseInt(
          process.env['FFE_CROWDING_COOLDOWN_SEC'] || '300',
          10,
        ),
      },

      dataIntegrity: {
        maxTickGapMs: parseInt(
          process.env['FFE_DI_MAX_TICK_GAP_MS'] || '5000',
          10,
        ),
        maxBookGapMs: parseInt(
          process.env['FFE_DI_MAX_BOOK_GAP_MS'] || '3000',
          10,
        ),
        maxOiAgeMs: parseInt(
          process.env['FFE_DI_MAX_OI_AGE_MS'] || '300000',
          10,
        ),
        maxSpreadPct: parseFloat(
          process.env['FFE_DI_MAX_SPREAD_PCT'] || '0.003',
        ),
        minTopDepthUsd: parseFloat(
          process.env['FFE_DI_MIN_TOP_DEPTH_USD'] || '10000',
        ),
        minTrades10s: parseInt(process.env['FFE_DI_MIN_TRADES_10S'] || '5', 10),
        maxReconnects5min: parseInt(
          process.env['FFE_DI_MAX_RECONNECTS_5MIN'] || '3',
          10,
        ),
        startupGracePeriodMs: parseInt(
          process.env['FFE_DI_STARTUP_GRACE_MS'] || '30000',
          10,
        ),
      },
    };

    const { error, value } = configSchema.validate(rawConfig, {
      abortEarly: false,
      allowUnknown: false,
    });

    if (error) {
      const errorMessage = error.details
        .map((detail) => detail.message)
        .join(', ');
      throw new Error(`Configuration validation failed: ${errorMessage}`);
    }

    Object.assign(this, value);

    // TypeScript assignment
    this.nodeEnv = value.nodeEnv;
    this.logLevel = value.logLevel;
    this.simulation = value.simulation;
    this.symbols = value.symbols;
    this.telegram = value.telegram;
    this.exchange = value.exchange;
    this.redis = value.redis;
    this.mongo = value.mongo;
    this.liqBurst = value.liqBurst;
    this.stall = value.stall;
    this.risk = value.risk;
    this.exits = value.exits;
    this.features = value.features;
    this.crowding = value.crowding;
    this.dataIntegrity = value.dataIntegrity;
  }

  isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  isTestnet(): boolean {
    return this.exchange.testnet;
  }

  hasApiKeys(): boolean {
    return !!(this.exchange.apiKey && this.exchange.secret);
  }

  isObserveOnly(): boolean {
    return this.simulation || !this.hasApiKeys();
  }

  isSimulation(): boolean {
    return this.simulation;
  }

  getSymbolForBinance(symbol: string): string {
    // ETH/USDT:USDT -> ETHUSDT
    return symbol.replace('/', '').replace(':USDT', '');
  }
}

export default ConfigService;
