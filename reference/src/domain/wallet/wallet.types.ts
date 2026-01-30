import Decimal from 'decimal.js';

/**
 * Token balances
 */
export interface Balances {
  /** USDC balance (human-readable) */
  usdc: Decimal;
  /** WETH balance (human-readable) */
  weth: Decimal;
  /** Native ETH balance for gas */
  ethForGas: Decimal;
  /** Total value in USDC (using reference price) */
  totalValueUsdc?: Decimal;
  /** WETH value in USDC */
  wethValueUsdc?: Decimal;
  /** WETH percentage of total */
  wethPercent?: Decimal;
  /** USDC percentage of total */
  usdcPercent?: Decimal;
  /** Timestamp */
  timestamp: number;
}

/**
 * Token info
 */
export interface TokenInfo {
  /** Token address */
  address: string;
  /** Token symbol */
  symbol: string;
  /** Token decimals */
  decimals: number;
}

/**
 * Allowance check result
 */
export interface AllowanceResult {
  /** Whether allowance is sufficient */
  ok: boolean;
  /** Current allowance amount */
  currentAllowance: Decimal;
  /** Required amount */
  requiredAmount: Decimal;
  /** Whether approval was made */
  approvalMade: boolean;
  /** Transaction hash if approval was made */
  txHash?: string;
  /** New allowance after approval */
  newAllowance?: Decimal;
  /** Token address */
  token: string;
  /** Spender address */
  spender: string;
  /** Error if failed */
  error?: string;
}

/**
 * Swap direction (per spec 2.1)
 */
export type SwapDirection = 'WETH_TO_USDC' | 'USDC_TO_WETH' | 'NONE';

/**
 * Swap parameters for exactInputSingle
 */
export interface SwapParams {
  /** Token to sell */
  tokenIn: string;
  /** Token to receive */
  tokenOut: string;
  /** Amount to sell (human-readable) */
  amountIn: Decimal;
  /** Minimum amount to receive (human-readable) */
  amountOutMin: Decimal;
  /** Recipient address */
  recipient: string;
  /** Deadline timestamp */
  deadline: number;
  /** Fee tier of the pool */
  fee: number;
}

/**
 * Swap result
 */
export interface SwapResult {
  /** Whether swap was successful */
  success: boolean;
  /** Direction of swap */
  direction: SwapDirection;
  /** Amount sold */
  amountIn: Decimal;
  /** Amount received */
  amountOut: Decimal;
  /** Effective price */
  effectivePrice: Decimal;
  /** Slippage incurred (bps) */
  slippageBps: Decimal;
  /** Transaction hash */
  txHash: string;
  /** Gas used */
  gasUsed?: Decimal;
  /** Error if failed */
  error?: string;
}

/**
 * Rebalance input parameters (per spec 2.1)
 */
export interface RebalanceParams {
  /** Reference price ETH in USDC (from PriceService) */
  referencePrice: Decimal;
  /** Deviation threshold (e.g., 0.05 = 5%) */
  deviationThresholdPct: number;
  /** Max slippage in bps (e.g., 30 = 0.30%) */
  maxSlippageBps: number;
  /** Deadline in seconds (e.g., 120) */
  deadlineSec: number;
  /** Minimum notional in USDC for swap (skip if delta < this) */
  minNotionalUsdc?: number;
  /** Dry run - return plan without executing tx */
  dryRun?: boolean;
  /** 
   * Target WETH percentage (0-100). Default is 50 for 50/50 rebalance.
   * For optimal Uniswap V3 minting, use calculateOptimalRatioForRange() to get the target.
   */
  targetWethPercent?: number;
}

/**
 * Rebalance to 50/50 result (per spec 2.1)
 */
export interface RebalanceResult {
  /** Whether swap was performed */
  performed: boolean;
  /** Swap direction */
  direction: SwapDirection;
  /** Amount given to router */
  amountIn?: Decimal;
  /** Minimum expected out */
  amountOutMin?: Decimal;
  /** Actual amount out (if available from logs) */
  amountOut?: Decimal;
  /** Transaction hash */
  txHash?: string;
  /** Balances before rebalance */
  balancesBefore: Balances;
  /** Balances after rebalance */
  balancesAfter?: Balances;
  /** Reason for decision */
  reason: string;
  /** Deviation percent before swap */
  deviationPercentBefore?: Decimal;
  /** Whether rebalance was needed (but might not have been performed) */
  rebalanceNeeded: boolean;
  /** Success flag */
  success: boolean;
  /** Swap details (legacy compatibility) */
  swap?: SwapResult;
  /** Target WETH value (legacy compatibility) */
  targetWethValue?: Decimal;
  /** Actual WETH value (legacy compatibility) */
  actualWethValue?: Decimal;
  /** Deviation percent (legacy compatibility) */
  deviationPercent?: Decimal;
  /** Error if failed */
  error?: string;
}

/**
 * Swap policy configuration (per spec section 4)
 */
export interface SwapPolicyConfig {
  /** Enable swap functionality */
  enabled: boolean;
  /** Deviation threshold percent (e.g., 0.05 = 5%) */
  deviationThresholdPct: number;
  /** Max slippage in bps (e.g., 30 = 0.30%) */
  maxSlippageBps: number;
  /** Deadline in seconds */
  deadlineSec: number;
  /** Minimum notional for swap (skip if delta < this) */
  minNotionalUsdc: number;
}

/**
 * Wallet service configuration
 */
export interface WalletServiceConfig {
  /** Default slippage tolerance in bps (e.g., 50 = 0.5%) */
  defaultSlippageBps: number;
  /** Maximum slippage tolerance in bps */
  maxSlippageBps: number;
  /** Minimum ETH to keep for gas */
  minEthForGas: Decimal;
  /** Approval amount (max uint256 or specific) */
  approvalAmount: 'max' | Decimal;
  /** Deadline buffer in seconds */
  deadlineBufferSeconds: number;
  /** Minimum rebalance threshold (percent deviation from 50/50) */
  minRebalanceThresholdPercent: Decimal;
  /** Swap policy (from ConfigService) */
  swapPolicy?: SwapPolicyConfig;
}

/**
 * Token approval parameters
 */
export interface ApprovalParams {
  /** Token to approve */
  token: string;
  /** Spender address */
  spender: string;
  /** Amount to approve (use 'max' for unlimited) */
  amount: Decimal | 'max';
}
