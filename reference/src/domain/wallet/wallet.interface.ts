import Decimal from 'decimal.js';
import {
  Balances,
  AllowanceResult,
  RebalanceResult,
  RebalanceParams,
  WalletServiceConfig,
  TokenInfo,
} from './wallet.types';

/**
 * Wallet Service interface
 * Manages wallet on selected network: balances, approvals, swaps for 50/50 rebalance
 */
export interface IWalletService {
  /**
   * Get current token balances
   * @returns Balances including USDC, WETH, and ETH for gas
   */
  getBalances(): Promise<Balances>;

  /**
   * Get balances with value calculations
   * @param referencePrice - Current ETH/USDC price
   * @returns Balances with total value and percentages
   */
  getBalancesWithValue(referencePrice: Decimal): Promise<Balances>;

  /**
   * Ensure token allowance is sufficient for spender
   * Approves if needed
   * @param token - Token address
   * @param spender - Spender address (e.g., Position Manager, Swap Router)
   * @param minAmount - Minimum required allowance
   * @returns Allowance result
   */
  ensureAllowance(
    token: string,
    spender: string,
    minAmount: Decimal
  ): Promise<AllowanceResult>;

  /**
   * Rebalance holdings to approximately 50/50 WETH/USDC (new signature per spec 2.1)
   * This is needed before minting a new LP position
   * @param params - Rebalance parameters
   * @returns Rebalance result with full details
   */
  rebalanceTo50_50(params: RebalanceParams): Promise<RebalanceResult>;

  /**
   * Rebalance holdings to approximately 50/50 WETH/USDC (legacy signature)
   * @param targetTotalUsdc - Target total value in USDC
   * @param referencePrice - Current ETH/USDC price
   * @param maxSlippageBps - Maximum slippage in basis points
   * @returns Rebalance result
   */
  rebalanceTo50_50(
    targetTotalUsdc: Decimal,
    referencePrice: Decimal,
    maxSlippageBps?: number
  ): Promise<RebalanceResult>;

  /**
   * Get current allowance for token/spender
   * @param token - Token address
   * @param spender - Spender address
   * @returns Current allowance (human-readable)
   */
  getAllowance(token: string, spender: string): Promise<Decimal>;

  /**
   * Approve token spending
   * @param token - Token address
   * @param spender - Spender address
   * @param amount - Amount to approve (or 'max' for unlimited)
   * @returns Transaction hash
   */
  approve(token: string, spender: string, amount: Decimal | 'max'): Promise<string>;

  /**
   * Swap tokens via DEX router
   * @param tokenIn - Token to sell
   * @param tokenOut - Token to receive
   * @param amountIn - Amount to sell
   * @param minAmountOut - Minimum amount to receive
   * @returns Transaction hash
   */
  swap(
    tokenIn: string,
    tokenOut: string,
    amountIn: Decimal,
    minAmountOut: Decimal
  ): Promise<string>;

  /**
   * Get wallet address
   */
  getAddress(): string;

  /**
   * Get token info
   * @param token - Token address
   */
  getTokenInfo(token: string): TokenInfo;

  /**
   * Check if wallet has sufficient ETH for gas
   * @param estimatedGas - Estimated gas cost in ETH
   * @returns Whether wallet has sufficient gas
   */
  hasSufficientGas(estimatedGas: Decimal): Promise<boolean>;

  /**
   * Wrap ETH to WETH
   * @param amount - Amount of ETH to wrap
   * @returns Transaction hash
   */
  wrapEth(amount: Decimal): Promise<string>;

  /**
   * Unwrap WETH to ETH
   * @param amount - Amount of WETH to unwrap
   * @returns Transaction hash
   */
  unwrapWeth(amount: Decimal): Promise<string>;

  /**
   * Get current config
   */
  getConfig(): WalletServiceConfig;

  /**
   * Update config
   * @param config - Partial config to update
   */
  updateConfig(config: Partial<WalletServiceConfig>): void;
}
