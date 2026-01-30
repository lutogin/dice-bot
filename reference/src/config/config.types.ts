import Decimal from 'decimal.js';

// ==================== Network & DEX ====================

export interface Web3Config {
  /** RPC URL for the blockchain */
  rpcUrl: string;
  /** Chain ID (1 = Mainnet, 42161 = Arbitrum, 8453 = Base) */
  chainId: number;
  /** Private key for signing transactions */
  privateKey: string;
  /** Uniswap v3 NonfungiblePositionManager address */
  positionManagerAddress: string;
  /** Uniswap v3 Factory address */
  factoryAddress: string;
  /** Uniswap v3 SwapRouter address */
  swapRouterAddress: string;
  /** Default slippage tolerance (0.5 = 0.5%) */
  defaultSlippageTolerance: number;
  /** Default transaction deadline in seconds */
  defaultDeadlineSeconds: number;
  /** Gas price multiplier for faster transactions */
  gasPriceMultiplier: number;
  /** Maximum gas price in gwei */
  maxGasPriceGwei: number;
}

export interface PoolConfig {
  /** Pool address on Uniswap v3 */
  poolAddress: string;
  /** Token0 address (usually ETH/WETH) */
  token0Address: string;
  /** Token1 address (usually USDC/USDT) */
  token1Address: string;
  /** Token0 symbol */
  token0Symbol: string;
  /** Token1 symbol */
  token1Symbol: string;
  /** Token0 decimals */
  token0Decimals: number;
  /** Token1 decimals */
  token1Decimals: number;
  /** Pool fee tier (500 = 0.05%, 3000 = 0.3%, 10000 = 1%) */
  feeTier: number;
  /** Uniswap v3 NonfungiblePositionManager address (overrides web3Config if set) */
  positionManagerAddress?: string;
}

// ==================== LP Range Strategy ====================
// All values are fractions: 0.10 = 10%, 0.04 = 4%

export interface LpRangeConfig {
  /** Range width as fraction (0.10 = ±10%) */
  rangeWidthPercent: number;
  /** Minimum range width as fraction (0.04 = ±4%) */
  rangeMinPercent: number;
  /** Maximum range width as fraction (0.15 = ±15%) */
  rangeMaxPercent: number;
  /** Whether to use symmetric range around current price */
  symmetricRange: boolean;
  /** Minimum tick spacing multiplier for range bounds */
  minTickSpacingMultiplier: number;
  /**
   * Auto-create LP position if none found at startup
   * Only works when SIMULATION_MODE=false and wallet has sufficient balance
   */
  autoCreateEnabled: boolean;
  /**
   * Minimum position value in USDC to be considered "active"
   * Positions below this threshold are treated as dust and ignored
   * Default: 50
   */
  minPositionValueUsdc: number;
}

// ==================== Rebalance Strategy ====================

export interface RebalanceConfig {
  rebalanceBeforeMint: boolean;
  rebalanceImbalanceThresholdPct: number;
}

// ==================== Hedge (Short) Exchange ====================

export interface HedgeExchangeConfig {
  /** Exchange ID (e.g., 'binance', 'okx', 'bybit') */
  id: string;
  /** Exchange name for display */
  name: string;
  /** API key */
  apiKey: string;
  /** API secret */
  secret: string;
  /** API passphrase (for OKX) */
  passphrase?: string;
  /** Whether exchange is enabled */
  enabled: boolean;
  /** Use testnet */
  testnet: boolean;
  /** Taker fee rate (e.g., 0.0004 = 0.04%) */
  takerFee: Decimal;
  /** Maker fee rate */
  makerFee: Decimal;
  /** Trading symbol for hedge (e.g., 'ETH/USDT:USDT') */
  hedgeSymbol: string;
  /** Leverage for perpetual futures */
  leverage: number;
  /** Margin mode: 'cross' or 'isolated' */
  marginMode: 'cross' | 'isolated';
  /** Minimum trade notional in USDC (default: 10) */
  minTradeNotional?: number;
}

/** @deprecated Use HedgeExchangeConfig instead */
export type ExchangeConfig = HedgeExchangeConfig;

// ==================== Hedge Execution ====================

/**
 * Configuration for hedge execution strategy (maker-prefer + fallback)
 */
export interface HedgeExecutionConfig {
  /** Timeout for maker order to fill (ms) */
  makerTimeoutMs: number;
  /** Maximum maker attempts before fallback */
  maxMakerAttempts: number;
  /** Fallback mode when maker fails: 'IOC' or 'MARKET' */
  fallbackMode: 'IOC' | 'MARKET';
  /** Max impact (slippage) in bps for NORMAL urgency */
  maxImpactBpsNormal: number;
  /** Max impact (slippage) in bps for MARGIN_DANGER urgency */
  maxImpactBpsDanger: number;
  /** Tick offset from best price for maker orders */
  makerTickOffset: number;
  /** Minimum notional to trigger rehedge (USDC) */
  minRehedgeNotionalUsdc: number;
  /** Maximum single order size (USDC) - for chunking large orders */
  maxOrderSizeUsdc: number;
  /** Delay between retry attempts (ms) */
  retryDelayMs: number;
}

// ==================== Margin & Risk Limits ====================

export interface MarginConfig {
  /** Minimum margin ratio to maintain (e.g., 0.2 = 20%) */
  minMarginRatio: number;
  /** Target margin ratio (e.g., 0.5 = 50%) */
  targetMarginRatio: number;
  /** Maximum position size in USDC */
  maxPositionSizeUsdc: number;
}

// ==================== Monitoring & Alerts ====================

export interface MonitoringConfig {
  /** Health check interval expression (cron) */
  healthCheckExpression: string;
  /** Position sync check interval expression (cron) */
  positionSyncExpression: string;
  /** Funding rate check interval expression (cron) */
  fundingRateCheckExpression: string;
}

// ==================== Database ====================

export interface DatabaseConfig {
  uri: string;
  name: string;
}

// ==================== Telegram ====================

export interface TelegramConfig {
  botToken: string;
  adminChatId: string;
}

// ==================== Strategy ====================

export interface StrategyConfig {
  /** Hedge ratio (0.8 = 80% of ETH exposure hedged) */
  hedgeRatio: number;
  /** Rehedge threshold percent (0.20 = 20% deviation triggers rehedge) */
  rehedgeThresholdPercent: number;
  /** Reset range when price is within this percent of boundary (0.025 = 2.5%) */
  resetNearBoundaryPercent: number;
  /** Minimum rehedge amount in USDC */
  minRehedgeAmountUsdc: number;
  /** Minimum time between rehedges in seconds (cooldown) */
  minRehedgeIntervalSec?: number;
  /** Minimum time between resets in seconds (anti-churn) */
  minTimeBetweenResetsSec?: number;
  /** Maximum resets allowed per 24 hours (protection) */
  maxResetsPer24h?: number;

  // Zone-based rehedge protection
  /** Fraction of LP range considered "near boundary" (0.15 = 15% on each side) */
  boundaryZoneWidth?: number;
  /** Threshold multiplier in protective zone (0.5 = half threshold near boundary) */
  protectiveThresholdMultiplier?: number;

  // Hysteresis for anti-churn
  /**
   * Hysteresis factor for rehedge decision (e.g., 1.3 = 30% higher enter threshold)
   * ENTER_THRESHOLD = baseThreshold * zoneMultiplier * hysteresisFactor
   * EXIT_THRESHOLD = baseThreshold * zoneMultiplier
   * Prevents oscillation when drift hovers around threshold.
   * Default: 1.3
   */
  hysteresisFactor?: number;

  /**
   * EMA window in minutes for LP delta smoothing (e.g., 15-30 min)
   * Used to filter noise from instant LP delta changes
   * Time-based formula: alpha = 1 - exp(-dt / tau), where tau = emaWindowMinutes * 60s
   * This ensures consistent smoothing regardless of sampling frequency
   * Default: 20
   */
  emaWindowMinutes?: number;

  /**
   * Soft hedge gap threshold (e.g., 0.07 = 7%)
   * When |currentShort - targetShort| / targetShort exceeds this,
   * rehedge is triggered but respects cooldown.
   * This catches cases where hedge drifted from target due to
   * reset/partial fills/anchor updates without hedge sync.
   * Default: 0.07
   */
  hedgeGapSoft?: number;

  /**
   * Hard hedge gap threshold (e.g., 0.12 = 12%)
   * When gap exceeds this, rehedge immediately (ignores drift/hysteresis/cooldown).
   * Safety trigger to prevent large delta exposure.
   * Default: 0.12
   */
  hedgeGapHard?: number;

  /**
   * Separate cooldown for soft gap rehedge triggers (seconds).
   * Longer than normal rehedge cooldown to prevent churn from partial fills.
   * Soft gap respects this cooldown; hard gap ignores all cooldowns.
   * Default: 3600 (1 hour)
   */
  softGapRehedgeIntervalSec?: number;
}

// ==================== Risk ====================

export interface RiskConfig {
  // Margin / Liquidation thresholds (as fractions: 0.30 = 30%)
  /** Minimum safe distance to liquidation (0.30 = 30% = safe) */
  minLiquidationDistancePercent: number;
  /** Danger distance to liquidation (0.25 = 25% = urgent rehedge) */
  dangerLiquidationDistancePercent: number;
  /** Emergency distance to liquidation (0.15 = 15% = immediate exit) */
  emergencyLiquidationDistancePercent: number;
  /** Maximum margin ratio before warning (0.20 = 20%) */
  maxMarginRatioPercent: number;

  // Price anomaly detection
  /** Maximum DEX-CEX spread as fraction (0.006 = 0.6%) */
  maxDexCexSpreadPercent: number;
  /** TWAP window seconds for price checks */
  twapWindowSeconds: number;
  /** CEX price stale threshold seconds */
  cexPriceStaleSeconds: number;
  /** DEX price stale threshold seconds */
  dexPriceStaleSeconds: number;

  // RPC health
  /** Maximum RPC latency ms */
  maxRpcLatencyMs: number;
  /** Maximum RPC error rate as fraction (0.30 = 30%) */
  maxRpcErrorRatePercent: number;
  /** Maximum block age seconds */
  maxBlockAgeSeconds: number;
  /** RPC down duration before emergency (seconds) */
  rpcDownEmergencySeconds: number;

  // CEX health
  /** CEX API timeout seconds */
  cexTimeoutSeconds: number;
  /** CEX down duration before emergency (seconds) */
  cexDownEmergencySeconds: number;

  // Drawdown (as fractions: 0.10 = 10%)
  /** Maximum drawdown before exit (0.10 = 10%) */
  maxDrawdownPercent: number;
  /** Warning drawdown level (0.05 = 5%) */
  warningDrawdownPercent: number;
}

// ==================== Price ====================

export interface PriceConfig {
  /** Maximum price age before considered stale (ms) */
  maxPriceAgeMs: number;
  /** Background refresh interval in seconds */
  refreshIntervalSec: number;
  /** Maximum deviation between sources before warning (percent) */
  maxDeviationPercent: number;
  /** Aggregation method for reference price */
  aggregationMethod:
    | 'median'
    | 'mean'
    | 'weighted'
    | 'cex_priority'
    | 'dex_priority';
  /** TWAP period in seconds */
  twapPeriodSeconds: number;
  /** Whether to use TWAP for DEX price */
  useTwap: boolean;
  /** Maximum TWAP deviation from spot price (fraction, e.g., 0.0065 = 0.65%) */
  maxTwapDeviationPercent: number;
  /** Weight for CEX price in weighted average */
  cexWeight: number;
  /** Weight for DEX price in weighted average */
  dexWeight: number;
  /** Minimum sources required for confidence */
  minSourcesForHighConfidence: number;
}

// ==================== Loop Timing ====================

export interface LoopConfig {
  /** Main strategy loop interval in seconds (full decision with RPC) */
  loopIntervalSec: number;
  /** RPC timeout in milliseconds */
  rpcTimeoutMs: number;
  /** CEX timeout in milliseconds */
  cexTimeoutMs: number;
  /** CEX price + hedge telemetry interval in seconds (cheap, no RPC) */
  cexTelemetryIntervalSec: number;
  /** DEX confirmation interval in seconds (RPC for slot0/tick only) */
  dexConfirmIntervalSec: number;
  /** LP bounds cache reconciliation interval in minutes */
  lpBoundsReconcileIntervalMin: number;
}

// ==================== Swap Policy ====================

/**
 * Swap policy configuration for 50/50 rebalancing (per spec section 4)
 */
export interface SwapPolicyConfig {
  /** Enable swap functionality */
  enabled: boolean;
  /** Deviation threshold as fraction (e.g., 0.05 = 5%) */
  deviationThresholdPct: number;
  /** Max slippage in bps (e.g., 30 = 0.30%) */
  maxSlippageBps: number;
  /** Deadline in seconds for swap transaction */
  deadlineSec: number;
  /** Minimum notional for swap in USDC (skip if delta < this to save gas) */
  minNotionalUsdc: number;
}

// ==================== Mint Policy ====================

/**
 * Mint policy configuration for LP position minting
 * Controls how much of available balance to use and safety margins
 */
export interface MintPolicyConfig {
  /** Use all available balances for mint (vs. specific amounts) */
  useAllBalances: boolean;
  /** Safety percentage - use this fraction of balance (0.995 = 99.5%) */
  amountSafetyPct: number;
  /**
   * Minimum amount0 as percentage of desired (0 = let Uniswap decide).
   * IMPORTANT: Uniswap V3 determines exact token ratio based on tick range.
   * Setting this to 0 means "accept whatever ratio Uniswap calculates".
   * Setting high values (e.g. 0.99) will cause "Price slippage check" reverts
   * when current price is not centered in the tick range.
   */
  amount0MinPct: number;
  /**
   * Minimum amount1 as percentage of desired (0 = let Uniswap decide).
   * See amount0MinPct for details.
   */
  amount1MinPct: number;
  /** Transaction deadline in seconds */
  deadlineSec: number;
  /** Minimum ETH required for a single transaction (gas check before mint) */
  reserveEthForGas: number;
  /** How much native ETH to keep when wrapping excess to WETH (buffer for multiple transactions) */
  wrapThresholdEth: number;
  /** Warning threshold - alert if leftover exceeds this percent (0.15 = 15%) */
  maxLeftoverPctWarn: number;
}

// ==================== Simulation ====================

export interface SimulationConfig {
  enabled: boolean;
}

// ==================== Main App Config ====================

export interface AppConfig {
  nodeEnv: string;
  logLevel: string;
  userTz: string;

  /** Web3/Blockchain configuration */
  web3: Web3Config;

  /** Uniswap v3 Pool configuration */
  pool: PoolConfig;

  /** LP Range strategy configuration */
  lpRange: LpRangeConfig;

  /** Rebalance strategy configuration */
  rebalance: RebalanceConfig;

  /** Hedge exchange configuration (CEX for short) */
  hedgeExchange: HedgeExchangeConfig;

  /** Margin and risk limits */
  margin: MarginConfig;

  /** Monitoring and alerts */
  monitoring: MonitoringConfig;

  /** Database configuration */
  database: DatabaseConfig;

  /** Telegram notifications */
  telegram: TelegramConfig;

  /** Simulation mode */
  simulation: SimulationConfig;

  /** Strategy configuration */
  strategy?: StrategyConfig;

  /** Risk thresholds configuration */
  risk?: RiskConfig;

  /** Price service configuration */
  price: PriceConfig;

  /** Loop timing configuration */
  loop?: LoopConfig;

  /** Swap policy for 50/50 rebalancing */
  swapPolicy?: SwapPolicyConfig;

  /** Mint policy for LP position creation */
  mintPolicy?: MintPolicyConfig;

  /** Hedge execution strategy configuration */
  hedgeExecution?: HedgeExecutionConfig;

  /** Dynamic rehedge threshold configuration */
  dynamicThreshold?: DynamicThresholdConfig;
}

// ==================== Dynamic Threshold ====================

export interface DynamicThresholdConfig {
  /** Enable dynamic threshold calculation (false = use static STRATEGY_REHEDGE_THRESHOLD) */
  enabled: boolean;
  /** Cron expression for recalculation schedule (default: every 30 min) */
  cronExpression: string;
  /** Base threshold before applying factors (e.g., 0.05 = 5%) */
  baseThreshold: number;
  /** Reference LP notional for size factor calculation (e.g., 25000 USDC) */
  referenceNotionalUsdc: number;
  /** Reference volatility for vol factor (e.g., 0.04 = 4%) */
  referenceVolatility: number;
  /** Minimum volatility factor */
  volFactorMin: number;
  /** Maximum volatility factor */
  volFactorMax: number;
  /** Minimum final threshold (floor) */
  thresholdMin: number;
  /** Maximum final threshold (ceiling) */
  thresholdMax: number;
  /** Enable cost factor calculation (requires fee estimation) */
  enableCostFactor: boolean;
  /** Maximum cost factor (cap) */
  costFactorMax: number;
  /** Estimated LP daily fees in USDC (for cost factor calculation) */
  lpDailyFeesEstimateUsdc: number;
}
