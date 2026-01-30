import Joi from 'joi';

// ==================== Web3 Config ====================

export const web3ConfigSchema = Joi.object({
  rpcUrl: Joi.string().uri().required(),
  chainId: Joi.number().integer().positive().required(),
  privateKey: Joi.string().required(),
  positionManagerAddress: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),
  factoryAddress: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),
  swapRouterAddress: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),
  defaultSlippageTolerance: Joi.number().min(0).max(100).default(0.5),
  defaultDeadlineSeconds: Joi.number().integer().positive().default(1800),
  gasPriceMultiplier: Joi.number().min(1).max(10).default(1.1),
  maxGasPriceGwei: Joi.number().integer().min(1).max(1000).default(100),
});

// ==================== Pool Config ====================

export const poolConfigSchema = Joi.object({
  poolAddress: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),
  token0Address: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),
  token1Address: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),
  token0Symbol: Joi.string().required(),
  token1Symbol: Joi.string().required(),
  token0Decimals: Joi.number().integer().min(0).max(18).required(),
  token1Decimals: Joi.number().integer().min(0).max(18).required(),
  feeTier: Joi.number().valid(100, 500, 3000, 10000).required(),
});

// ==================== LP Range Config ====================
// All values are fractions: 0.10 = 10%, 0.04 = 4%

export const lpRangeConfigSchema = Joi.object({
  rangeWidthPercent: Joi.number().min(0.01).max(0.5).default(0.1), // fraction: 0.10 = 10%
  rangeMinPercent: Joi.number().min(0.01).max(0.2).default(0.04), // fraction: 0.04 = 4%
  rangeMaxPercent: Joi.number().min(0.05).max(0.3).default(0.15), // fraction: 0.15 = 15%
  symmetricRange: Joi.boolean().default(true),
  minTickSpacingMultiplier: Joi.number().integer().min(1).default(1),
  autoCreateEnabled: Joi.boolean().default(false),
  minPositionValueUsdc: Joi.number().min(1).default(50),
});

// ==================== Rebalance Config ====================

export const rebalanceConfigSchema = Joi.object({
  rebalanceBeforeMint: Joi.boolean().default(true),
  rebalanceImbalanceThresholdPct: Joi.number().integer().min(1).default(5),
});

// ==================== Hedge Exchange Config ====================

export const hedgeExchangeConfigSchema = Joi.object({
  id: Joi.string().required(),
  name: Joi.string().required(),
  apiKey: Joi.string().required(),
  secret: Joi.string().required(),
  passphrase: Joi.string().optional(),
  enabled: Joi.boolean().default(true),
  testnet: Joi.boolean().default(false),
  takerFee: Joi.any(),
  makerFee: Joi.any(),
  hedgeSymbol: Joi.string().required(),
  leverage: Joi.number().integer().min(1).max(125).default(1),
  marginMode: Joi.string().valid('cross', 'isolated').default('cross'),
  minTradeNotional: Joi.number().min(0).default(300),
});

// ==================== Margin Config ====================

export const marginConfigSchema = Joi.object({
  minMarginRatio: Joi.number().min(0.05).max(1).default(0.2),
  targetMarginRatio: Joi.number().min(0.1).max(1).default(0.5),
  maxPositionSizeUsdc: Joi.number().min(100).default(100000),
});

// ==================== Monitoring Config ====================

export const monitoringConfigSchema = Joi.object({
  healthCheckExpression: Joi.string().default('0 */1 * * * *'),
  positionSyncExpression: Joi.string().default('0 */5 * * * *'),
  fundingRateCheckExpression: Joi.string().default('0 55 * * * *'),
});

// ==================== Price Config ====================

export const priceConfigSchema = Joi.object({
  maxPriceAgeMs: Joi.number().integer().min(1000).max(300000).default(30000),
  refreshIntervalSec: Joi.number().integer().min(5).max(300).default(15),
  maxDeviationPercent: Joi.number().min(0.01).max(10).default(1),
  aggregationMethod: Joi.string()
    .valid('median', 'mean', 'weighted', 'cex_priority', 'dex_priority')
    .default('weighted'),
  twapPeriodSeconds: Joi.number().integer().min(30).max(3600).default(300),
  useTwap: Joi.boolean().default(false),
  maxTwapDeviationPercent: Joi.number().min(0.0001).max(0.5).default(0.0065),
  cexWeight: Joi.number().min(0).max(1).default(0.6),
  dexWeight: Joi.number().min(0).max(1).default(0.4),
  minSourcesForHighConfidence: Joi.number().integer().min(1).max(3).default(2),
});

// ==================== Database Config ====================

export const databaseConfigSchema = Joi.object({
  uri: Joi.string().required(),
  name: Joi.string().required(),
});

// ==================== Telegram Config ====================

export const telegramConfigSchema = Joi.object({
  botToken: Joi.string().required(),
  adminChatId: Joi.string().required(),
});

// ==================== Simulation Config ====================

export const simulationConfigSchema = Joi.object({
  enabled: Joi.boolean().default(false),
});

// ==================== Strategy Config ====================

export const strategyConfigSchema = Joi.object({
  hedgeRatio: Joi.number().min(0).max(1).default(0.8),
  rehedgeThresholdPercent: Joi.number().min(0.01).max(1).default(0.2),
  resetNearBoundaryPercent: Joi.number().min(0.001).max(0.5).default(0.025),
  minRehedgeAmountUsdc: Joi.number().min(0).default(300),
  minRehedgeIntervalSec: Joi.number().integer().min(0).default(900), // 15 min cooldown
  minTimeBetweenResetsSec: Joi.number().integer().min(0).default(1800),
  maxResetsPer24h: Joi.number().integer().min(1).default(3),
  // Zone-based rehedge protection
  boundaryZoneWidth: Joi.number().min(0.05).max(0.4).default(0.15), // 15% of range
  protectiveThresholdMultiplier: Joi.number().min(0.1).max(1.0).default(0.5), // 50% threshold in zones
  // Hysteresis for anti-churn
  hysteresisFactor: Joi.number().min(1.0).max(2.0).default(1.3), // 1.3 = 30% higher enter threshold
  // EMA smoothing
  emaWindowMinutes: Joi.number().integer().min(5).max(60).default(20), // 20 min EMA window
  // Hedge gap safety triggers
  hedgeGapSoft: Joi.number().min(0.03).max(0.15).default(0.07), // 7% gap triggers rehedge (with cooldown)
  hedgeGapHard: Joi.number()
    .min(0.08)
    .max(0.25)
    .default(0.12)
    .custom((value, helpers) => {
      const soft = helpers.state.ancestors[0].hedgeGapSoft || 0.07;
      if (value <= soft) {
        return helpers.error('any.invalid', {
          message: 'hedgeGapHard must be greater than hedgeGapSoft',
        });
      }
      return value;
    }), // 12% gap forces immediate rehedge
  // Separate cooldown for soft gap (longer than normal rehedge cooldown)
  softGapRehedgeIntervalSec: Joi.number()
    .integer()
    .min(300) // minimum 5 minutes
    .max(14400) // maximum 4 hours
    .default(3600) // 1 hour default
    .custom((value, helpers) => {
      const normalCooldown =
        helpers.state.ancestors[0].minRehedgeIntervalSec || 900;
      if (value < normalCooldown) {
        return helpers.error('any.invalid', {
          message:
            'softGapRehedgeIntervalSec should be >= minRehedgeIntervalSec',
        });
      }
      return value;
    }),
});

// ==================== Risk Config ====================

export const riskConfigSchema = Joi.object({
  // Margin / Liquidation thresholds (as fractions: 0.30 = 30%)
  minLiquidationDistancePercent: Joi.number().min(0.01).max(1.0).default(0.35),
  dangerLiquidationDistancePercent: Joi.number()
    .min(0.01)
    .max(1.0)
    .default(0.35),
  emergencyLiquidationDistancePercent: Joi.number()
    .min(0.01)
    .max(1.0)
    .default(0.15),
  maxMarginRatioPercent: Joi.number().min(0.01).max(1.0).default(0.2),

  // Price anomaly (already as fractions)
  maxDexCexSpreadPercent: Joi.number().min(0).max(0.1).default(0.003),
  twapWindowSeconds: Joi.number().integer().min(60).max(3600).default(300),
  cexPriceStaleSeconds: Joi.number().integer().min(1).max(300).default(15),
  dexPriceStaleSeconds: Joi.number().integer().min(1).max(300).default(30),

  // RPC health
  maxRpcLatencyMs: Joi.number().integer().min(100).max(30000).default(1500),
  maxRpcErrorRatePercent: Joi.number().min(0).max(1.0).default(0.3), // fraction (0.30 = 30%)
  maxBlockAgeSeconds: Joi.number().integer().min(1).max(120).default(20),
  rpcDownEmergencySeconds: Joi.number().integer().min(10).max(600).default(180),

  // CEX health
  cexTimeoutSeconds: Joi.number().integer().min(1).max(120).default(10),
  cexDownEmergencySeconds: Joi.number().integer().min(10).max(600).default(60),

  // Drawdown (as fractions: 0.10 = 10%)
  maxDrawdownPercent: Joi.number().min(0.01).max(1.0).default(0.1),
  warningDrawdownPercent: Joi.number().min(0.01).max(1.0).default(0.05),
});

// ==================== Loop Config ====================

export const loopConfigSchema = Joi.object({
  loopIntervalSec: Joi.number().integer().min(5).max(300).default(60),
  rpcTimeoutMs: Joi.number().integer().min(500).max(30000).default(4000),
  cexTimeoutMs: Joi.number().integer().min(500).max(30000).default(2500),
  // Optimized loop intervals
  cexTelemetryIntervalSec: Joi.number().integer().min(5).max(60).default(10),
  dexConfirmIntervalSec: Joi.number().integer().min(30).max(300).default(60),
  lpBoundsReconcileIntervalMin: Joi.number()
    .integer()
    .min(5)
    .max(60)
    .default(15),
});

// ==================== Swap Policy Config ====================

export const swapPolicyConfigSchema = Joi.object({
  /** Enable swap functionality */
  enabled: Joi.boolean().default(true),
  /** Deviation threshold as fraction (0.05 = 5%) */
  deviationThresholdPct: Joi.number().min(0.001).max(0.5).default(0.002),
  /** Max slippage in bps (30 = 0.30%) */
  maxSlippageBps: Joi.number().integer().min(5).max(500).default(30),
  /** Deadline in seconds */
  deadlineSec: Joi.number().integer().min(30).max(600).default(120),
  /** Minimum notional for swap in USDC */
  minNotionalUsdc: Joi.number().min(10).max(10000).default(200),
});

// ==================== Mint Policy Config ====================

export const mintPolicyConfigSchema = Joi.object({
  /** Use all available balances for mint */
  useAllBalances: Joi.boolean().default(true),
  /** Safety percentage - use this fraction of balance (0.995 = 99.5%) */
  amountSafetyPct: Joi.number().min(0.9).max(1.0).default(0.995),
  /** Minimum amount0 as percentage of desired (0 = let Uniswap decide) */
  amount0MinPct: Joi.number().min(0).max(1.0).default(0),
  /** Minimum amount1 as percentage of desired (0 = let Uniswap decide) */
  amount1MinPct: Joi.number().min(0).max(1.0).default(0),
  /** Transaction deadline in seconds */
  deadlineSec: Joi.number().integer().min(30).max(600).default(120),
  /** Reserve this much ETH for gas */
  reserveEthForGas: Joi.number().min(0.001).max(0.5).default(0.01),
  /** Warning threshold - alert if leftover exceeds this percent */
  maxLeftoverPctWarn: Joi.number().min(0.05).max(0.5).default(0.15),
  /** Minimum native ETH to keep for gas (excess will be wrapped to WETH) */
  wrapThresholdEth: Joi.number().min(0.001).max(0.5).default(0.05),
});

// ==================== Hedge Execution Config ====================

export const hedgeExecutionConfigSchema = Joi.object({
  /** Timeout for maker order to fill (ms) */
  makerTimeoutMs: Joi.number().integer().min(500).max(30000).default(2500),
  /** Maximum maker attempts before fallback */
  maxMakerAttempts: Joi.number().integer().min(1).max(10).default(2),
  /** Fallback mode when maker fails */
  fallbackMode: Joi.string().valid('IOC', 'MARKET').default('IOC'),
  /** Max impact (slippage) in bps for NORMAL urgency */
  maxImpactBpsNormal: Joi.number().integer().min(1).max(100).default(10),
  /** Max impact (slippage) in bps for MARGIN_DANGER urgency */
  maxImpactBpsDanger: Joi.number().integer().min(10).max(200).default(50),
  /** Tick offset from best price for maker orders */
  makerTickOffset: Joi.number().integer().min(1).max(20).default(2),
  /** Minimum notional to trigger rehedge (USDC) */
  minRehedgeNotionalUsdc: Joi.number().min(10).max(10000).default(300),
  /** Maximum single order size (USDC) */
  maxOrderSizeUsdc: Joi.number().min(1000).max(1000000).default(50000),
  /** Delay between retry attempts (ms) */
  retryDelayMs: Joi.number().integer().min(100).max(5000).default(500),
});

// ==================== Dynamic Threshold Config ====================

export const dynamicThresholdConfigSchema = Joi.object({
  /** Enable dynamic threshold (false = use static STRATEGY_REHEDGE_THRESHOLD) */
  enabled: Joi.boolean().default(false),
  /** Cron expression for recalculation schedule */
  cronExpression: Joi.string().default('*/30 * * * *'),
  /** Base threshold before factors (0.05 = 5%) */
  baseThreshold: Joi.number().min(0.01).max(0.2).default(0.05),
  /** Reference LP notional for size factor ($) */
  referenceNotionalUsdc: Joi.number().min(1000).max(1000000).default(25000),
  /** Reference volatility for vol factor (0.04 = 4%) */
  referenceVolatility: Joi.number().min(0.01).max(0.3).default(0.04),
  /** Minimum volatility factor */
  volFactorMin: Joi.number().min(0.3).max(1.0).default(0.8),
  /** Maximum volatility factor */
  volFactorMax: Joi.number().min(1.0).max(3.0).default(1.3),
  /** Minimum final threshold floor (0.03 = 3%) */
  thresholdMin: Joi.number().min(0.01).max(0.1).default(0.03),
  /** Maximum final threshold ceiling (0.08 = 8%) */
  thresholdMax: Joi.number().min(0.03).max(0.2).default(0.08),
  /** Enable cost factor calculation */
  enableCostFactor: Joi.boolean().default(false),
  /** Maximum cost factor cap */
  costFactorMax: Joi.number().min(1.0).max(5.0).default(2.0),
  /** Estimated LP daily fees in USDC (for cost factor calculation) */
  lpDailyFeesEstimateUsdc: Joi.number().min(0).default(5),
});

// ==================== Main App Config ====================

export const appConfigSchema = Joi.object({
  nodeEnv: Joi.string()
    .valid('development', 'production', 'test', 'dev', 'loc', 'prod')
    .default('development'),
  logLevel: Joi.string()
    .valid('error', 'warn', 'info', 'debug')
    .default('info'),
  userTz: Joi.string().default('Europe/Warsaw'),

  web3: web3ConfigSchema.required(),
  pool: poolConfigSchema.required(),
  lpRange: lpRangeConfigSchema.required(),
  rebalance: rebalanceConfigSchema.required(),
  hedgeExchange: hedgeExchangeConfigSchema.required(),
  margin: marginConfigSchema.required(),
  monitoring: monitoringConfigSchema.required(),
  price: priceConfigSchema.required(),
  database: databaseConfigSchema.required(),
  telegram: telegramConfigSchema.required(),
  simulation: simulationConfigSchema.required(),
  strategy: strategyConfigSchema.optional(),
  risk: riskConfigSchema.optional(),
  loop: loopConfigSchema.optional(),
  swapPolicy: swapPolicyConfigSchema.optional(),
  mintPolicy: mintPolicyConfigSchema.optional(),
  hedgeExecution: hedgeExecutionConfigSchema.optional(),
  dynamicThreshold: dynamicThresholdConfigSchema.optional(),
});
