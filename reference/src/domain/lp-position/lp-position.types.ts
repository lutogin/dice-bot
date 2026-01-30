import Decimal from 'decimal.js';

/**
 * LP Position info from Uniswap v3 NFT
 */
export interface PositionInfo {
  /** NFT token ID */
  tokenId: string;
  /** Token0 address */
  token0: string;
  /** Token1 address */
  token1: string;
  /** Pool fee tier (500 = 0.05%, 3000 = 0.3%, 10000 = 1%) */
  fee: number;
  /** Lower tick of the position range */
  tickLower: number;
  /** Upper tick of the position range */
  tickUpper: number;
  /** Current liquidity in the position */
  liquidity: Decimal;
  /** Token0 symbol */
  token0Symbol?: string;
  /** Token1 symbol */
  token1Symbol?: string;
  /** Lower price bound */
  priceLower?: Decimal;
  /** Upper price bound */
  priceUpper?: Decimal;
}

/**
 * Pool state information
 */
export interface PoolState {
  /** Pool address */
  poolAddress: string;
  /** Current sqrt price X96 */
  sqrtPriceX96: bigint;
  /** Current tick */
  tick: number;
  /** Current spot price (human-readable) */
  spotPrice: Decimal;
  /** Pool liquidity */
  liquidity: bigint;
  /** Fee tier */
  fee: number;
  /** Token0 address */
  token0: string;
  /** Token1 address */
  token1: string;
  /** Observation index */
  observationIndex: number;
  /** Observation cardinality */
  observationCardinality: number;
  /** Whether pool is unlocked */
  unlocked: boolean;
  /** Timestamp */
  timestamp: number;
}

/**
 * Position composition - detailed breakdown
 */
export interface CompositionResult {
  /** Amount of WETH (token0) in the position */
  wethAmount: Decimal;
  /** Amount of USDC (token1) in the position */
  usdcAmount: Decimal;
  /** WETH value in USDC */
  wethValueUsdc: Decimal;
  /** Total value in USDC */
  totalValueUsdc: Decimal;
  /** Whether current price is within the position range */
  inRange: boolean;
  /** Current tick */
  currentTick: number;
  /** Position tick lower */
  tickLower: number;
  /** Position tick upper */
  tickUpper: number;
  /** Distance to lower bound (percent) */
  distanceToLowerPercent: Decimal;
  /** Distance to upper bound (percent) */
  distanceToUpperPercent: Decimal;
  /** Position range width in percent */
  rangeWidthPercent: Decimal;
  /** Timestamp */
  timestamp: number;
}

/**
 * Transaction result for LP operations
 */
export interface LpTxResult {
  /** Whether operation succeeded */
  success: boolean;
  /** Transaction hash */
  txHash: string;
  /** Block number */
  blockNumber?: number;
  /** Gas used */
  gasUsed?: Decimal;
  /** Amount0 involved */
  amount0?: Decimal;
  /** Amount1 involved */
  amount1?: Decimal;
  /** New liquidity (for mint/increase) */
  liquidity?: Decimal;
  /** New token ID (for mint) */
  newTokenId?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Parameters for minting a new position
 */
export interface MintPositionParams {
  /** Lower tick */
  tickLower: number;
  /** Upper tick */
  tickUpper: number;
  /** Amount of USDC to add */
  amountUsdc: Decimal;
  /** Amount of WETH to add */
  amountWeth: Decimal;
  /** Slippage tolerance in bps (default from config) */
  slippageBps?: number;
  /** Deadline in seconds from now */
  deadlineSeconds?: number;
}

/**
 * Parameters for decreasing liquidity
 */
export interface DecreaseLiquidityParams {
  /** Percentage of liquidity to remove (0-100) */
  percent: number;
  /** Slippage tolerance in bps */
  slippageBps?: number;
  /** Deadline in seconds from now */
  deadlineSeconds?: number;
}

/**
 * Result of collecting fees
 */
export interface CollectFeesResult {
  /** Amount of token0 (WETH) collected */
  amount0: Decimal;
  /** Amount of token1 (USDC) collected */
  amount1: Decimal;
  /** Transaction hash */
  txHash: string;
  /** Total value collected in USDC */
  totalValueUsdc?: Decimal;
}

/**
 * Legacy types for backward compatibility
 */
export interface LpPosition extends PositionInfo {
  feeGrowthInside0LastX128?: Decimal;
  feeGrowthInside1LastX128?: Decimal;
  tokensOwed0?: Decimal;
  tokensOwed1?: Decimal;
}

export interface LpPositionComposition {
  amount0: Decimal;
  amount1: Decimal;
  token0Symbol: string;
  token1Symbol: string;
}

export interface LiquidityOperationResult {
  liquidity: Decimal;
  amount0: Decimal;
  amount1: Decimal;
  txHash: string;
}

export interface RebalanceResult {
  oldTokenId: string;
  newTokenId: string;
  newPosition: LpPosition;
  feesCollected: CollectFeesResult;
  txHashes: string[];
}

export interface IncreaseLiquidityParams {
  tokenId: string;
  amount0Desired: Decimal;
  amount1Desired: Decimal;
  amount0Min?: Decimal;
  amount1Min?: Decimal;
  deadline?: number;
}

// ==================== Mint for Budget Types ====================

/**
 * Budget policy for minting - controls how much of available balance to use
 */
export interface BudgetPolicy {
  /** Use all available balances (vs. specific amounts) */
  useAllBalances: boolean;
  /** Reserve this much ETH for gas (native token) */
  reserveEthForGas: Decimal;
  /** Safety percentage - use this fraction of balance (0.995 = 99.5%) */
  amountSafetyPct: Decimal;
  /** Minimum amount0 as percentage of desired (0.99 = 99%) */
  amount0MinPct: Decimal;
  /** Minimum amount1 as percentage of desired (0.99 = 99%) */
  amount1MinPct: Decimal;
  /** Transaction deadline in seconds */
  deadlineSec: number;
  /** Warning threshold - alert if leftover exceeds this percent (0.15 = 15%) */
  maxLeftoverPctWarn: Decimal;
}

/**
 * Result of minting a position for budget
 */
export interface MintForBudgetResult {
  /** Whether mint was successful */
  success: boolean;
  /** New NFT token ID */
  newTokenId?: string;
  /** Transaction hash */
  txHash?: string;
  /** USDC actually used in mint */
  usedUsdc: Decimal;
  /** WETH actually used in mint */
  usedWeth: Decimal;
  /** USDC leftover in wallet */
  leftoverUsdc: Decimal;
  /** WETH leftover in wallet */
  leftoverWeth: Decimal;
  /** Leftover as percentage of total value */
  leftoverPct: Decimal;
  /** Liquidity minted */
  liquidity?: Decimal;
  /** Reason for any adjustments or fallbacks */
  reason: string;
  /** Error message if failed */
  error?: string;
  /** Tick lower used */
  tickLower: number;
  /** Tick upper used */
  tickUpper: number;
  /** Reference price used for calculations */
  referencePrice: Decimal;
  /** Balances before mint */
  balancesBefore: {
    usdc: Decimal;
    weth: Decimal;
    ethForGas: Decimal;
  };
  /** Balances after mint */
  balancesAfter?: {
    usdc: Decimal;
    weth: Decimal;
    ethForGas: Decimal;
  };
}

/**
 * Parameters for mintNewPositionForBudget
 */
export interface MintForBudgetParams {
  /** Lower tick of the range */
  tickLower: number;
  /** Upper tick of the range */
  tickUpper: number;
  /** Budget policy (optional - uses config defaults) */
  budgetPolicy?: Partial<BudgetPolicy>;
  /** Recipient address for the NFT (optional - uses wallet address) */
  recipientAddress?: string;
  /** Reference price for logging (optional - fetches from pool) */
  referencePrice?: Decimal;
}

// ==================== Wallet Position Discovery Types ====================

/**
 * Summary of an LP position owned by the wallet
 */
export interface WalletPositionSummary {
  /** NFT token ID */
  tokenId: string;
  /** Token0 address */
  token0: string;
  /** Token1 address */
  token1: string;
  /** Pool fee tier */
  fee: number;
  /** Lower tick */
  tickLower: number;
  /** Upper tick */
  tickUpper: number;
  /** Current liquidity (0 if position was decreased to 0) */
  liquidity: Decimal;
  /** Whether this position matches the configured pool */
  matchesConfigPool: boolean;
  /** Whether this position has liquidity > 0 */
  hasLiquidity: boolean;
}

/**
 * Result of discovering all LP positions for wallet
 */
export interface WalletPositionsResult {
  /** Total number of NFTs owned by wallet */
  totalNfts: number;
  /** All positions (including other pools) */
  allPositions: WalletPositionSummary[];
  /** Positions that match the configured pool (token0, token1, fee) */
  matchingPoolPositions: WalletPositionSummary[];
  /** Active positions for configured pool (matching + liquidity > 0) */
  activePositions: WalletPositionSummary[];
  /** Best candidate for active LP (active with highest liquidity) */
  bestActivePosition: WalletPositionSummary | null;
}
