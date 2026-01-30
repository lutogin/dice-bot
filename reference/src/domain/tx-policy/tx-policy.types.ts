import Decimal from 'decimal.js';
import { ethers } from 'ethers';

/**
 * Transaction status
 */
export type TxStatus = 'pending' | 'confirmed' | 'failed' | 'replaced' | 'stuck' | 'timeout';

/**
 * EIP-1559 gas parameters
 */
export interface GasParams {
  /** Max fee per gas in wei */
  maxFeePerGas: bigint;
  /** Max priority fee per gas in wei */
  maxPriorityFeePerGas: bigint;
  /** Gas limit */
  gasLimit?: bigint;
  /** Max fee per gas in Gwei (for display) */
  maxFeePerGasGwei: Decimal;
  /** Max priority fee in Gwei (for display) */
  maxPriorityFeeGwei: Decimal;
  /** Estimated total cost in ETH */
  estimatedCostEth?: Decimal;
  /** Timestamp when params were fetched */
  timestamp: number;
}

/**
 * Transaction call data
 */
export interface TxCallData {
  /** Target contract address */
  to: string;
  /** Encoded function data */
  data: string;
  /** Value to send in wei */
  value?: bigint;
  /** Gas limit override */
  gasLimit?: bigint;
  /** Description of the transaction */
  description?: string;
  /** Custom nonce (optional, will use getNextNonce if not provided) */
  nonce?: number;
  /** Custom gas params (optional, will use buildGasParams if not provided) */
  gasParams?: Partial<GasParams>;
}

/**
 * Transaction result
 */
export interface TxResult {
  /** Transaction hash */
  txHash: string;
  /** Nonce used */
  nonce: number;
  /** Gas params used */
  gasParams: GasParams;
  /** Timestamp when sent */
  sentAt: number;
  /** Transaction status */
  status: TxStatus;
  /** Description */
  description?: string;
  /** Error if failed */
  error?: string;
}

/**
 * Transaction receipt with additional info
 */
export interface TxReceipt {
  /** Original transaction hash */
  txHash: string;
  /** Block number */
  blockNumber: number;
  /** Block hash */
  blockHash: string;
  /** Number of confirmations */
  confirmations: number;
  /** Gas used */
  gasUsed: bigint;
  /** Effective gas price */
  effectiveGasPrice: bigint;
  /** Transaction status (1 = success, 0 = revert) */
  status: number;
  /** Total cost in ETH */
  costEth: Decimal;
  /** Timestamp of confirmation */
  confirmedAt: number;
  /** Logs */
  logs: readonly ethers.Log[];
}

/**
 * Nonce tracking info
 */
export interface NonceInfo {
  /** Wallet address */
  wallet: string;
  /** Last confirmed nonce */
  confirmedNonce: number;
  /** Pending nonce (next to use) */
  pendingNonce: number;
  /** In-flight transactions (nonce -> txHash) */
  inFlightTxs: Map<number, string>;
  /** Last update timestamp */
  lastUpdate: number;
}

/**
 * Stuck transaction info
 */
export interface StuckTxInfo {
  /** Original transaction hash */
  txHash: string;
  /** Nonce */
  nonce: number;
  /** Time since sent in ms */
  ageMs: number;
  /** Original gas params */
  originalGasParams: GasParams;
  /** Replacement attempts */
  replacementAttempts: number;
}

/**
 * Transaction policy configuration
 */
export interface TxPolicyConfig {
  /** Max gas price in Gwei */
  maxGasPriceGwei: Decimal;
  /** Priority fee multiplier (e.g., 1.2 for 20% higher) */
  priorityFeeMultiplier: Decimal;
  /** Gas limit multiplier for estimation */
  gasLimitMultiplier: Decimal;
  /** Default gas limit if estimation fails */
  defaultGasLimit: bigint;
  /** Timeout for transaction confirmation in seconds */
  confirmationTimeoutSec: number;
  /** Minimum confirmations required */
  minConfirmations: number;
  /** Time before considering tx stuck in ms */
  stuckThresholdMs: number;
  /** Max replacement attempts for stuck tx */
  maxReplacementAttempts: number;
  /** Gas bump percentage for replacement (e.g., 0.2 for 20% higher) */
  gasBumpPercent: Decimal;
  /** Polling interval for confirmation in ms */
  pollingIntervalMs: number;
  /** Whether to use EIP-1559 (default true) */
  useEip1559: boolean;
}

/**
 * Transaction tracking entry
 */
export interface TxTrackingEntry {
  /** Transaction result */
  result: TxResult;
  /** Receipt if confirmed */
  receipt?: TxReceipt;
  /** Replacement tx if replaced */
  replacementTx?: TxResult;
  /** Created at */
  createdAt: number;
  /** Updated at */
  updatedAt: number;
}

/**
 * Pending transaction pool
 */
export interface PendingTxPool {
  /** Transactions by hash */
  byHash: Map<string, TxTrackingEntry>;
  /** Transactions by nonce */
  byNonce: Map<number, TxTrackingEntry>;
  /** Oldest pending tx timestamp */
  oldestPending?: number;
  /** Count of pending */
  pendingCount: number;
}
