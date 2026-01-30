import {
  GasParams,
  TxCallData,
  TxResult,
  TxReceipt,
  TxPolicyConfig,
  NonceInfo,
  StuckTxInfo,
  TxTrackingEntry,
} from './tx-policy.types';

/**
 * Transaction Policy Service interface
 * Unified policy for on-chain transactions: nonce, gas, retries
 */
export interface ITxPolicyService {
  /**
   * Get next nonce for wallet
   * Accounts for pending transactions, not just confirmed
   * @param wallet - Wallet address (optional, uses configured wallet)
   * @returns Next nonce to use
   */
  getNextNonce(wallet?: string): Promise<number>;

  /**
   * Build gas parameters (EIP-1559)
   * Based on current network conditions and config limits
   * @param gasLimit - Optional gas limit override
   * @returns Gas parameters
   */
  buildGasParams(gasLimit?: bigint): Promise<GasParams>;

  /**
   * Send transaction with proper nonce and gas management
   * @param callData - Transaction call data
   * @returns Transaction result with hash and nonce
   */
  sendTx(callData: TxCallData): Promise<TxResult>;

  /**
   * Wait for transaction confirmation
   * @param txHash - Transaction hash
   * @param minConfirmations - Minimum confirmations (optional, uses config)
   * @param timeoutSec - Timeout in seconds (optional, uses config)
   * @returns Transaction receipt
   * @throws Error if timeout (stuck transaction)
   */
  waitConfirmed(
    txHash: string,
    minConfirmations?: number,
    timeoutSec?: number
  ): Promise<TxReceipt>;

  /**
   * Bump gas and replace stuck transaction
   * Uses same nonce with higher gas to replace pending tx
   * @param txHash - Original transaction hash
   * @returns New transaction result
   */
  bumpAndReplace(txHash: string): Promise<TxResult>;

  /**
   * Get nonce info for wallet
   * @param wallet - Wallet address (optional)
   * @returns Nonce tracking info
   */
  getNonceInfo(wallet?: string): Promise<NonceInfo>;

  /**
   * Get stuck transactions
   * @returns List of stuck transaction info
   */
  getStuckTransactions(): StuckTxInfo[];

  /**
   * Get transaction tracking entry
   * @param txHash - Transaction hash
   * @returns Tracking entry or undefined
   */
  getTransaction(txHash: string): TxTrackingEntry | undefined;

  /**
   * Get all pending transactions
   * @returns Array of pending transaction entries
   */
  getPendingTransactions(): TxTrackingEntry[];

  /**
   * Cancel pending transaction by sending 0 ETH to self with same nonce
   * @param nonce - Nonce to cancel
   * @returns Cancellation transaction result
   */
  cancelTransaction(nonce: number): Promise<TxResult>;

  /**
   * Estimate gas for call data
   * @param callData - Transaction call data
   * @returns Estimated gas limit
   */
  estimateGas(callData: TxCallData): Promise<bigint>;

  /**
   * Get current config
   */
  getConfig(): TxPolicyConfig;

  /**
   * Update config
   * @param config - Partial config to update
   */
  updateConfig(config: Partial<TxPolicyConfig>): void;

  /**
   * Clear transaction history
   */
  clearHistory(): void;

  /**
   * Reset nonce tracking (force refresh from network)
   * @param wallet - Wallet address (optional)
   */
  resetNonceTracking(wallet?: string): Promise<void>;
}
