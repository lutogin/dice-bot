import dotenv from 'dotenv';
import { injectable } from 'tsyringe';

import { AppConfig } from './config.types';
import { appConfigSchema } from './config.validation';
import Decimal from 'decimal.js';
import * as process from 'node:process';

// Load environment variables
dotenv.config();

@injectable()
export class ConfigService implements AppConfig {
  readonly nodeEnv!: string;
  readonly logLevel!: string;
  readonly userTz!: string;
  readonly web3!: AppConfig['web3'];
  readonly pool!: AppConfig['pool'];
  readonly lpRange!: AppConfig['lpRange'];
  readonly rebalance!: AppConfig['rebalance'];
  readonly hedgeExchange!: AppConfig['hedgeExchange'];
  readonly margin!: AppConfig['margin'];
  readonly monitoring!: AppConfig['monitoring'];
  readonly database!: AppConfig['database'];
  readonly telegram!: AppConfig['telegram'];
  readonly simulation!: AppConfig['simulation'];
  readonly strategy?: AppConfig['strategy'];
  readonly risk?: AppConfig['risk'];
  readonly price!: AppConfig['price'];
  readonly loop?: AppConfig['loop'];
  readonly swapPolicy?: AppConfig['swapPolicy'];
  readonly mintPolicy?: AppConfig['mintPolicy'];
  readonly hedgeExecution?: AppConfig['hedgeExecution'];
  readonly dynamicThreshold?: AppConfig['dynamicThreshold'];

  constructor() {
    const config = this.createConfig();
    Object.assign(this, config);
  }

  isSimulationMode(): boolean {
    return this.simulation.enabled;
  }

  isDevEnv(): boolean {
    return ['dev', 'loc', 'development'].includes(this.nodeEnv);
  }

  isProduction(): boolean {
    return ['production', 'prod'].includes(this.nodeEnv);
  }

  /**
   * Get the pool pair symbol (e.g., 'ETH/USDC')
   */
  getPoolPairSymbol(): string {
    return `${this.pool.token0Symbol}/${this.pool.token1Symbol}`;
  }

  /**
   * Get hedge symbol for CEX (e.g., 'ETH/USDT:USDT')
   */
  getHedgeSymbol(): string {
    return this.hedgeExchange.hedgeSymbol;
  }

  private createConfig(): AppConfig {
    const rawConfig = {
      nodeEnv: process.env['NODE_ENV'] || 'development',
      logLevel: process.env['LOG_LEVEL'] || 'info',
      userTz: process.env['USER_TZ'] || 'Europe/Warsaw',

      // ==================== Web3 Config ====================
      // MVP: Arbitrum One (chainId 42161)
      web3: {
        rpcUrl: process.env['WEB3_RPC_URL'] || 'https://arb1.arbitrum.io/rpc',
        chainId: Number(process.env['WEB3_CHAIN_ID'] || '42161'), // Arbitrum One
        privateKey: process.env['WEB3_PRIVATE_KEY'] || '',
        // Uniswap v3 Arbitrum addresses
        positionManagerAddress:
          process.env['UNISWAP_POSITION_MANAGER'] ||
          '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', // Same on Arbitrum
        factoryAddress:
          process.env['UNISWAP_FACTORY'] ||
          '0x1F98431c8aD98523631AE4a59f267346ea31F984', // Same on Arbitrum
        swapRouterAddress:
          process.env['UNISWAP_SWAP_ROUTER'] ||
          '0xE592427A0AEce92De3Edee1F18E0157C05861564', // SwapRouter (v1)
        defaultSlippageTolerance: Number(
          process.env['WEB3_SLIPPAGE_TOLERANCE'] || '0.5',
        ),
        defaultDeadlineSeconds: Number(
          process.env['WEB3_DEADLINE_SECONDS'] || '1800',
        ),
        gasPriceMultiplier: Number(
          process.env['WEB3_GAS_PRICE_MULTIPLIER'] || '1.1',
        ),
        maxGasPriceGwei: Number(
          process.env['WEB3_MAX_GAS_PRICE_GWEI'] || '100',
        ),
      },

      // ==================== Pool Config ====================
      // MVP: Arbitrum WETH/USDC 0.05% pool
      pool: {
        poolAddress:
          process.env['POOL_ADDRESS'] ||
          '0xC6962004f452bE9203591991D15f6b388e09E8D0', // Arbitrum WETH/USDC 0.05%
        token0Address:
          process.env['POOL_TOKEN0_ADDRESS'] ||
          '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH on Arbitrum
        token1Address:
          process.env['POOL_TOKEN1_ADDRESS'] ||
          '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC on Arbitrum
        token0Symbol: process.env['POOL_TOKEN0_SYMBOL'] || 'WETH',
        token1Symbol: process.env['POOL_TOKEN1_SYMBOL'] || 'USDC',
        token0Decimals: Number(process.env['POOL_TOKEN0_DECIMALS'] || '18'),
        token1Decimals: Number(process.env['POOL_TOKEN1_DECIMALS'] || '6'),
        feeTier: Number(process.env['POOL_FEE_TIER'] || '500'), // 0.05% (tickSpacing = 10)
      },

      // ==================== LP Range Config ====================
      // All values are fractions: 0.10 = 10%, 0.04 = 4%
      lpRange: {
        rangeWidthPercent: Number(process.env['LP_RANGE_WIDTH'] || '0.10'), // 0.10 = ±10%
        rangeMinPercent: Number(process.env['LP_RANGE_MIN'] || '0.04'), // 0.04 = ±4%
        rangeMaxPercent: Number(process.env['LP_RANGE_MAX'] || '0.15'), // 0.15 = ±15%
        symmetricRange: process.env['LP_SYMMETRIC_RANGE'] !== 'false',
        minTickSpacingMultiplier: Number(
          process.env['LP_MIN_TICK_SPACING_MULTIPLIER'] || '1',
        ),
        autoCreateEnabled: process.env['LP_AUTO_CREATE_ENABLED'] === 'true',
        /** Minimum position value in USDC to be considered "active" (dust threshold) */
        minPositionValueUsdc: Number(
          process.env['LP_MIN_POSITION_VALUE_USDC'] || '50',
        ),
      },

      // ==================== Rebalance Config ====================
      rebalance: {
        rebalanceBeforeMint:
          process.env['REBALANCE_BEFORE_MINT'] === 'true' ||
          process.env['REBALANCE_BEFORE_MINT'] === 'TRUE',
        rebalanceImbalanceThresholdPct: Number(
          process.env['REBALANCE_IMBALANCE_THRESHOLD_PCT'] || '5',
        ),
      },

      // ==================== Hedge Exchange Config ====================
      // MVP: Binance perps ETHUSDT
      hedgeExchange: {
        id: process.env['HEDGE_EXCHANGE_ID'] || 'binance',
        name: process.env['HEDGE_EXCHANGE_NAME'] || 'Binance',
        apiKey: process.env['HEDGE_EXCHANGE_API_KEY'] || '',
        secret: process.env['HEDGE_EXCHANGE_SECRET'] || '',
        passphrase: process.env['HEDGE_EXCHANGE_PASSPHRASE'] || undefined,
        enabled: process.env['HEDGE_EXCHANGE_ENABLED'] !== 'false',
        testnet: process.env['HEDGE_EXCHANGE_TESTNET'] === 'true',
        takerFee: new Decimal(
          process.env['HEDGE_EXCHANGE_TAKER_FEE'] || '0.0004',
        ),
        makerFee: new Decimal(
          process.env['HEDGE_EXCHANGE_MAKER_FEE'] || '0.0002',
        ),
        hedgeSymbol: process.env['HEDGE_SYMBOL'] || 'ETH/USDT:USDT', // Binance perps ETHUSDT
        leverage: Number(process.env['HEDGE_LEVERAGE'] || '1'), // MVP: max 1.5x
        marginMode:
          (process.env['HEDGE_MARGIN_MODE'] as 'cross' | 'isolated') || 'cross',
        minTradeNotional: Number(
          process.env['HEDGE_MIN_TRADE_NOTIONAL'] || '300',
        ), // MVP: don't move on tiny amounts
      },

      // ==================== Margin Config ====================
      // MVP: Conservative leverage
      margin: {
        minMarginRatio: Number(process.env['MARGIN_MIN_RATIO'] || '0.2'),
        targetMarginRatio: Number(process.env['MARGIN_TARGET_RATIO'] || '0.5'),
        maxPositionSizeUsdc: Number(
          process.env['MARGIN_MAX_POSITION_SIZE_USDC'] || '100000',
        ),
      },

      // ==================== Monitoring Config ====================
      monitoring: {
        healthCheckExpression:
          process.env['MONITORING_HEALTH_CHECK'] || '0 */1 * * * *',
        positionSyncExpression:
          process.env['MONITORING_POSITION_SYNC'] || '0 */5 * * * *',
        fundingRateCheckExpression:
          process.env['MONITORING_FUNDING_RATE'] || '0 55 * * * *',
      },

      // ==================== Price Config ====================
      price: {
        maxPriceAgeMs: Number(process.env['PRICE_MAX_AGE_MS'] || '30000'),
        refreshIntervalSec: Number(
          process.env['PRICE_REFRESH_INTERVAL_SEC'] || '15',
        ),
        maxDeviationPercent: Number(
          process.env['PRICE_MAX_DEVIATION_PCT'] || '1',
        ),
        aggregationMethod:
          (process.env['PRICE_AGGREGATION_METHOD'] as
            | 'median'
            | 'mean'
            | 'weighted'
            | 'cex_priority'
            | 'dex_priority') || 'weighted',
        twapPeriodSeconds: Number(
          process.env['PRICE_TWAP_PERIOD_SEC'] || '300',
        ),
        useTwap: process.env['PRICE_USE_TWAP'] === 'true',
        maxTwapDeviationPercent: Number(
          process.env['PRICE_MAX_TWAP_DEVIATION'] || '0.0075',
        ),
        cexWeight: Number(process.env['PRICE_CEX_WEIGHT'] || '0.6'),
        dexWeight: Number(process.env['PRICE_DEX_WEIGHT'] || '0.4'),
        minSourcesForHighConfidence: Number(
          process.env['PRICE_MIN_SOURCES'] || '2',
        ),
      },

      // ==================== Database Config ====================
      database: {
        uri:
          process.env['MONGODB_URI'] ||
          'mongodb://localhost:27017/hedged-lp-bot',
        name: process.env['MONGODB_DB_NAME'] || 'hedged_lp_bot',
      },

      // ==================== Telegram Config ====================
      telegram: {
        botToken: process.env['TELEGRAM_BOT_TOKEN'] || '',
        adminChatId: process.env['TELEGRAM_ADMIN_CHAT_ID'] || '',
      },

      // ==================== Simulation Config ====================
      simulation: {
        enabled: process.env['SIMULATION_MODE'] === 'true',
      },

      // ==================== Strategy Config ====================
      // MVP values for Arbitrum + Uniswap v3 WETH/USDC 0.05% + Binance perps
      strategy: {
        hedgeRatio: Number(process.env['STRATEGY_HEDGE_RATIO'] || '0.8'),
        rehedgeThresholdPercent: Number(
          process.env['STRATEGY_REHEDGE_THRESHOLD'] || '0.20',
        ),
        resetNearBoundaryPercent: Number(
          process.env['STRATEGY_RESET_NEAR_BOUNDARY'] || '0.025',
        ),
        minRehedgeAmountUsdc: Number(
          process.env['STRATEGY_MIN_REHEDGE_AMOUNT'] || '300',
        ),
        minRehedgeIntervalSec: Number(
          process.env['STRATEGY_MIN_REHEDGE_INTERVAL_SEC'] || '900',
        ), // 15 min cooldown
        minTimeBetweenResetsSec: Number(
          process.env['STRATEGY_MIN_TIME_BETWEEN_RESETS'] || '1800',
        ), // 30 min
        maxResetsPer24h: Number(
          process.env['STRATEGY_MAX_RESETS_PER_24H'] || '3',
        ),
        // Zone-based rehedge protection
        boundaryZoneWidth: Number(
          process.env['REHEDGE_BOUNDARY_ZONE_WIDTH'] || '0.15',
        ), // 15% of range
        protectiveThresholdMultiplier: Number(
          process.env['REHEDGE_PROTECTIVE_MULTIPLIER'] || '0.5',
        ), // 50% threshold in zones
        // Hysteresis for anti-churn
        hysteresisFactor: Number(
          process.env['STRATEGY_HYSTERESIS_FACTOR'] || '1.3',
        ), // 30% higher enter threshold
        // EMA smoothing for LP delta
        emaWindowMinutes: Number(
          process.env['STRATEGY_EMA_WINDOW_MINUTES'] || '20',
        ), // 20 min EMA window
        // Hedge gap safety triggers
        hedgeGapSoft: Number(process.env['STRATEGY_HEDGE_GAP_SOFT'] || '0.07'), // 7% gap triggers rehedge (respects cooldown)
        hedgeGapHard: Number(process.env['STRATEGY_HEDGE_GAP_HARD'] || '0.12'), // 12% gap forces immediate rehedge (bypasses cooldown)
        // Separate cooldown for soft gap (longer than normal rehedge cooldown)
        softGapRehedgeIntervalSec: Number(
          process.env['STRATEGY_SOFT_GAP_REHEDGE_INTERVAL_SEC'] || '3600',
        ), // 1 hour cooldown for soft gap triggers
      },

      // ==================== Risk Config ====================
      // MVP conservative values for Arbitrum + Binance
      // All values are fractions (0.30 = 30%)
      risk: {
        // Margin / Liquidation distances (fractions: 0.35 = 35%)
        minLiquidationDistancePercent: Number(
          process.env['RISK_MIN_LIQ_DISTANCE'] || '0.35',
        ),
        dangerLiquidationDistancePercent: Number(
          process.env['RISK_DANGER_LIQ_DISTANCE'] || '0.35',
        ),
        emergencyLiquidationDistancePercent: Number(
          process.env['RISK_EMERGENCY_LIQ_DISTANCE'] || '0.15',
        ),
        maxMarginRatioPercent: Number(
          process.env['RISK_MAX_MARGIN_RATIO'] || '0.20',
        ),

        // Price anomaly (fractions: 0.003 = 0.3%)
        maxDexCexSpreadPercent: Number(
          process.env['RISK_MAX_DEX_CEX_SPREAD'] || '0.003',
        ),
        twapWindowSeconds: Number(process.env['RISK_TWAP_WINDOW_SEC'] || '300'), // 5 min
        cexPriceStaleSeconds: Number(
          process.env['RISK_CEX_PRICE_STALE_SEC'] || '15',
        ),
        dexPriceStaleSeconds: Number(
          process.env['RISK_DEX_PRICE_STALE_SEC'] || '30',
        ),

        // RPC health (L2 tolerant)
        maxRpcLatencyMs: Number(
          process.env['RISK_MAX_RPC_LATENCY_MS'] || '1500',
        ),
        maxRpcErrorRatePercent: Number(
          process.env['RISK_MAX_RPC_ERROR_RATE'] || '0.30',
        ), // fraction (0.30 = 30%)
        maxBlockAgeSeconds: Number(
          process.env['RISK_MAX_BLOCK_AGE_SEC'] || '20',
        ),
        rpcDownEmergencySeconds: Number(
          process.env['RISK_RPC_DOWN_EMERGENCY_SEC'] || '180',
        ), // 3 min

        // CEX health
        cexTimeoutSeconds: Number(process.env['RISK_CEX_TIMEOUT_SEC'] || '10'),
        cexDownEmergencySeconds: Number(
          process.env['RISK_CEX_DOWN_EMERGENCY_SEC'] || '60',
        ), // 1 min

        // Drawdown (fractions: 0.10 = 10%)
        maxDrawdownPercent: Number(process.env['RISK_MAX_DRAWDOWN'] || '0.10'),
        warningDrawdownPercent: Number(
          process.env['RISK_WARNING_DRAWDOWN'] || '0.05',
        ),
      },

      // ==================== Loop Timing Config ====================
      loop: {
        loopIntervalSec: Number(process.env['LOOP_INTERVAL_SEC'] || '60'),
        rpcTimeoutMs: Number(process.env['LOOP_RPC_TIMEOUT_MS'] || '4000'),
        cexTimeoutMs: Number(process.env['LOOP_CEX_TIMEOUT_MS'] || '2500'),
        // New optimized intervals
        cexTelemetryIntervalSec: Number(
          process.env['LOOP_CEX_TELEMETRY_INTERVAL_SEC'] || '10',
        ),
        dexConfirmIntervalSec: Number(
          process.env['LOOP_DEX_CONFIRM_INTERVAL_SEC'] || '60',
        ),
        lpBoundsReconcileIntervalMin: Number(
          process.env['LOOP_LP_BOUNDS_RECONCILE_MIN'] || '15',
        ),
      },

      // ==================== Swap Policy Config ====================
      // Per spec section 4: controls 50/50 rebalancing before mint
      swapPolicy: {
        enabled: process.env['SWAP_ENABLED'] !== 'false',
        deviationThresholdPct: Number(
          process.env['SWAP_DEVIATION_THRESHOLD_PCT'] || '0.002',
        ), // fraction (0.05 = 5%)
        maxSlippageBps: Number(
          process.env['REBALANCE_MAX_SLIPPAGE_BPS'] || '30',
        ), // 0.30%
        deadlineSec: Number(process.env['REBALANCE_DEADLINE_SEC'] || '120'), // 2 min
        minNotionalUsdc: Number(
          process.env['REBALANCE_MIN_NOTIONAL_USDC'] || '200',
        ), // Skip small swaps
      },

      // ==================== Mint Policy Config ====================
      // Controls how LP positions are minted with available balances
      mintPolicy: {
        useAllBalances: process.env['MINT_USE_ALL_BALANCES'] !== 'false',
        amountSafetyPct: Number(
          process.env['MINT_AMOUNT_SAFETY_PCT'] || '0.995',
        ), // Use 99.5%
        // IMPORTANT: Uniswap V3 determines exact token ratio based on tick range and current price.
        // Setting these to 0 allows Uniswap to take what it needs; leftover stays in wallet.
        amount0MinPct: Number(process.env['MINT_AMOUNT0_MIN_PCT'] || '0'), // 0% min - let Uniswap decide
        amount1MinPct: Number(process.env['MINT_AMOUNT1_MIN_PCT'] || '0'), // 0% min - let Uniswap decide
        deadlineSec: Number(process.env['MINT_DEADLINE_SEC'] || '120'), // 2 min
        /** Minimum ETH required for a single transaction (gas check) */
        reserveEthForGas: Number(
          process.env['MINT_RESERVE_ETH_FOR_GAS'] || '0.01',
        ), // 0.01 ETH
        /** How much native ETH to keep when wrapping excess to WETH (buffer for multiple tx) */
        wrapThresholdEth: Number(process.env['WRAP_THRESHOLD_ETH'] || '0.05'), // 0.05 ETH (~$150)
        maxLeftoverPctWarn: Number(
          process.env['MINT_MAX_LEFTOVER_PCT_WARN'] || '0.50',
        ), // 50% - high leftover is expected
      },

      // ==================== Hedge Execution Config ====================
      // Controls maker-prefer + fallback strategy for hedge orders
      hedgeExecution: {
        makerTimeoutMs: Number(process.env['HEDGE_MAKER_TIMEOUT_MS'] || '2500'), // 2.5 sec
        maxMakerAttempts: Number(
          process.env['HEDGE_MAX_MAKER_ATTEMPTS'] || '2',
        ),
        fallbackMode: (process.env['HEDGE_FALLBACK_MODE'] || 'IOC') as
          | 'IOC'
          | 'MARKET',
        maxImpactBpsNormal: Number(
          process.env['HEDGE_MAX_IMPACT_BPS_NORMAL'] || '10',
        ),
        maxImpactBpsDanger: Number(
          process.env['HEDGE_MAX_IMPACT_BPS_DANGER'] || '50',
        ),
        makerTickOffset: Number(process.env['HEDGE_MAKER_TICK_OFFSET'] || '2'),
        minRehedgeNotionalUsdc: Number(
          process.env['HEDGE_MIN_REHEDGE_NOTIONAL_USDC'] || '300',
        ), // only as fallback
        maxOrderSizeUsdc: Number(
          process.env['HEDGE_MAX_ORDER_SIZE_USDC'] || '50000',
        ),
        retryDelayMs: Number(process.env['HEDGE_RETRY_DELAY_MS'] || '500'),
      },

      // ==================== Dynamic Threshold Config ====================
      // Cost-benefit based rehedge threshold calculation
      // threshold = base * sizeFactor * volFactor * costFactor * boundaryFactor
      dynamicThreshold: {
        enabled: process.env['DYNAMIC_THRESHOLD_ENABLED'] === 'true',
        cronExpression: process.env['DYNAMIC_THRESHOLD_CRON'] || '*/30 * * * *',
        baseThreshold: Number(process.env['DYNAMIC_THRESHOLD_BASE'] || '0.05'), // 5%
        referenceNotionalUsdc: Number(
          process.env['DYNAMIC_THRESHOLD_REF_NOTIONAL'] || '25000',
        ), // $25k
        referenceVolatility: Number(
          process.env['DYNAMIC_THRESHOLD_REF_VOL'] || '0.04',
        ), // 4%
        volFactorMin: Number(
          process.env['DYNAMIC_THRESHOLD_VOL_FACTOR_MIN'] || '0.8',
        ),
        volFactorMax: Number(
          process.env['DYNAMIC_THRESHOLD_VOL_FACTOR_MAX'] || '1.3',
        ),
        thresholdMin: Number(process.env['DYNAMIC_THRESHOLD_MIN'] || '0.03'), // 3% floor
        thresholdMax: Number(process.env['DYNAMIC_THRESHOLD_MAX'] || '0.08'), // 8% ceiling
        enableCostFactor:
          process.env['DYNAMIC_THRESHOLD_COST_FACTOR_ENABLED'] === 'true',
        costFactorMax: Number(
          process.env['DYNAMIC_THRESHOLD_COST_FACTOR_MAX'] || '2.0',
        ),
        lpDailyFeesEstimateUsdc: Number(
          process.env['DYNAMIC_THRESHOLD_LP_DAILY_FEES_USDC'] || '5',
        ),
      },
    };

    // Validate configuration
    const { error, value } = appConfigSchema.validate(rawConfig, {
      abortEarly: false,
      allowUnknown: false,
    });

    if (error) {
      const errorMessage = error.details
        .map((detail) => detail.message)
        .join(', ');
      throw new Error(`Configuration validation failed: ${errorMessage}`);
    }

    return value as AppConfig;
  }
}

// For backward compatibility
const configInstance = new ConfigService();
export const config = configInstance;
export default config;
