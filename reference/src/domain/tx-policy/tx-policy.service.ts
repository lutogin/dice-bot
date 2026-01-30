import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';
import { ethers } from 'ethers';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import type { IMonitoringService } from '../monitoring';
import { ITxPolicyService } from './tx-policy.interface';
import {
  GasParams,
  TxCallData,
  TxResult,
  TxReceipt,
  TxPolicyConfig,
  NonceInfo,
  StuckTxInfo,
  TxTrackingEntry,
  TxStatus,
} from './tx-policy.types';

/**
 * Default transaction policy configuration
 */
const DEFAULT_CONFIG: TxPolicyConfig = {
  maxGasPriceGwei: new Decimal(100),
  priorityFeeMultiplier: new Decimal(1.2),
  gasLimitMultiplier: new Decimal(1.3),
  defaultGasLimit: BigInt(500000),
  confirmationTimeoutSec: 300, // 5 minutes
  minConfirmations: 1,
  stuckThresholdMs: 120000, // 2 minutes
  maxReplacementAttempts: 3,
  gasBumpPercent: new Decimal(0.2), // 20% bump
  pollingIntervalMs: 5000, // 5 seconds
  useEip1559: true,
};

const GWEI = BigInt(1e9);

/**
 * Transaction Policy Service
 * Unified policy for on-chain transactions: nonce, gas, retries
 * Ensures LP rebalancing and range resets don't cause nonce chaos
 */
@injectable()
export class TxPolicyService implements ITxPolicyService {
  private readonly logger: ILogger;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly wallet: ethers.Wallet;
  private config: TxPolicyConfig;

  // Nonce tracking
  private localNonce: number = -1;
  private nonceInitialized: boolean = false;

  // Transaction tracking
  private txHistory: Map<string, TxTrackingEntry> = new Map();
  private pendingByNonce: Map<number, string> = new Map(); // nonce -> txHash

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE) private readonly configService: ConfigService,
    @inject(TOKENS.MONITORING_SERVICE) private readonly monitoringService: IMonitoringService
  ) {
    this.logger = logger.child('TxPolicyService');

    // Initialize provider and wallet
    this.provider = new ethers.JsonRpcProvider(this.configService.web3.rpcUrl);
    this.wallet = new ethers.Wallet(this.configService.web3.privateKey, this.provider);

    // Initialize config from ConfigService
    this.config = {
      ...DEFAULT_CONFIG,
      maxGasPriceGwei: new Decimal(this.configService.web3.maxGasPriceGwei),
    };

    this.logger.info('TxPolicyService initialized', {
      wallet: this.wallet.address,
      chainId: this.configService.web3.chainId,
    });
  }

  // ==================== Nonce Management ====================

  /**
   * Get next nonce for wallet
   * Accounts for pending transactions
   */
  async getNextNonce(wallet?: string): Promise<number> {
    const address = wallet || this.wallet.address;

    try {
      // Get pending nonce from network (includes pending txs)
      const pendingNonce = await this.provider.getTransactionCount(address, 'pending');

      // Get confirmed nonce
      const confirmedNonce = await this.provider.getTransactionCount(address, 'latest');

      // Initialize local nonce if needed
      if (!this.nonceInitialized || this.localNonce < pendingNonce) {
        this.localNonce = pendingNonce;
        this.nonceInitialized = true;
      }

      // Use the highest of: network pending nonce, or our tracked local nonce
      const nextNonce = Math.max(pendingNonce, this.localNonce);

      // Check for nonce drift
      if (nextNonce > confirmedNonce + 10) {
        this.logger.warn('Nonce drift detected', {
          confirmed: confirmedNonce,
          pending: pendingNonce,
          local: this.localNonce,
        });

        await this.monitoringService.alertWarn('Nonce drift detected', {
          component: 'TxPolicyService',
          context: {
            confirmed: confirmedNonce,
            pending: pendingNonce,
            local: this.localNonce,
          },
        });
      }

      this.logger.debug('Next nonce calculated', {
        nextNonce,
        confirmed: confirmedNonce,
        pending: pendingNonce,
        local: this.localNonce,
      });

      return nextNonce;
    } catch (error) {
      this.logger.error('Failed to get nonce', error as Error);
      throw error;
    }
  }

  /**
   * Build EIP-1559 gas parameters
   */
  async buildGasParams(gasLimit?: bigint): Promise<GasParams> {
    try {
      const feeData = await this.provider.getFeeData();
      const timestamp = Date.now();

      let maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? null;
      let maxFeePerGas = feeData.maxFeePerGas ?? null;
      let baseFeePerGas: bigint | null = null;
      let gasPrice = feeData.gasPrice ?? null;

      if (!maxFeePerGas || !maxPriorityFeePerGas) {
        const block = await this.provider.getBlock('latest');
        baseFeePerGas = block?.baseFeePerGas ?? null;
        if (!gasPrice) {
          gasPrice = baseFeePerGas ? baseFeePerGas + GWEI : GWEI * BigInt(2);
        }

        if (baseFeePerGas) {
          if (!maxPriorityFeePerGas) {
            const derivedPriority = gasPrice > baseFeePerGas ? gasPrice - baseFeePerGas : GWEI;
            maxPriorityFeePerGas = derivedPriority;
          }
          if (!maxFeePerGas) {
            maxFeePerGas = baseFeePerGas + maxPriorityFeePerGas;
          }
          // This is expected behavior on L2s like Arbitrum - they don't return full EIP-1559 data
          this.logger.debug('Derived EIP-1559 params from baseFee', {
            baseFee: baseFeePerGas.toString(),
            gasPrice: gasPrice.toString(),
            maxFeePerGas: maxFeePerGas.toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          });
        } else {
          if (!maxPriorityFeePerGas) {
            maxPriorityFeePerGas = gasPrice / BigInt(2);
          }
          if (!maxFeePerGas) {
            maxFeePerGas = gasPrice;
          }
          // This is expected behavior on some networks
          this.logger.debug('Using gasPrice for EIP-1559 params (no baseFee)', {
            gasPrice: gasPrice?.toString(),
            maxFeePerGas: maxFeePerGas.toString(),
            maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
          });
        }
      }

      // Apply priority fee multiplier
      maxPriorityFeePerGas = BigInt(
        new Decimal(maxPriorityFeePerGas.toString())
          .mul(this.config.priorityFeeMultiplier)
          .floor()
          .toString()
      );

      // Ensure minimum priority fee (1 Gwei floor for L2 reliability)
      const minPriorityFee = GWEI; // 1 Gwei minimum
      if (maxPriorityFeePerGas < minPriorityFee) {
        this.logger.debug('Priority fee below minimum, bumping to 1 Gwei', {
          original: new Decimal(maxPriorityFeePerGas.toString()).div(1e9).toFixed(6),
          bumped: '1.0',
        });
        maxPriorityFeePerGas = minPriorityFee;
      }

      // Calculate max fee with buffer for base fee fluctuation
      // Use at least baseFee * 2 to handle base fee spikes
      if (baseFeePerGas) {
        const minBufferedFee = baseFeePerGas * BigInt(2);
        const calculatedFee = baseFeePerGas + maxPriorityFeePerGas;
        maxFeePerGas = calculatedFee > minBufferedFee ? calculatedFee : minBufferedFee;
      } else if (maxFeePerGas < maxPriorityFeePerGas) {
        maxFeePerGas = maxPriorityFeePerGas * BigInt(2);
      }

      // Apply gas price limit
      const maxGasWei = BigInt(this.config.maxGasPriceGwei.mul(1e9).floor().toString());
      if (maxFeePerGas > maxGasWei) {
        this.logger.warn('Gas price exceeds limit, capping', {
          requested: new Decimal(maxFeePerGas.toString()).div(1e9).toFixed(2),
          limit: this.config.maxGasPriceGwei.toFixed(2),
        });
        maxFeePerGas = maxGasWei;
        maxPriorityFeePerGas = maxGasWei / BigInt(2);
      }

      // Use provided gas limit or default
      const finalGasLimit = gasLimit || this.config.defaultGasLimit;

      // Calculate estimated cost
      const estimatedCostWei = maxFeePerGas * finalGasLimit;
      const estimatedCostEth = new Decimal(estimatedCostWei.toString()).div(1e18);

      const gasParams: GasParams = {
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit: finalGasLimit,
        maxFeePerGasGwei: new Decimal(maxFeePerGas.toString()).div(1e9),
        maxPriorityFeeGwei: new Decimal(maxPriorityFeePerGas.toString()).div(1e9),
        estimatedCostEth,
        timestamp,
      };

      this.logger.debug('Gas params built', {
        maxFeeGwei: gasParams.maxFeePerGasGwei.toFixed(2),
        priorityFeeGwei: gasParams.maxPriorityFeeGwei.toFixed(2),
        gasLimit: finalGasLimit.toString(),
        estimatedCostEth: estimatedCostEth.toFixed(6),
      });

      return gasParams;
    } catch (error) {
      this.logger.error('Failed to build gas params', error as Error);
      throw error;
    }
  }

  // ==================== Transaction Sending ====================

  /**
   * Send transaction with proper nonce and gas management
   */
  async sendTx(callData: TxCallData): Promise<TxResult> {
    const sentAt = Date.now();

    try {
      // Get nonce (use provided or fetch next)
      const nonce = callData.nonce ?? (await this.getNextNonce());

      // Estimate gas if not provided
      let gasLimit = callData.gasLimit;
      if (!gasLimit) {
        try {
          const estimated = await this.estimateGas(callData);
          gasLimit = BigInt(
            new Decimal(estimated.toString()).mul(this.config.gasLimitMultiplier).floor().toString()
          );
        } catch (e) {
          const errorMsg = (e as Error).message;
          
          // Check if this is a revert with a reason - means tx will definitely fail
          const isRevertError = errorMsg.includes('execution reverted') ||
                               errorMsg.includes('CALL_EXCEPTION') ||
                               errorMsg.includes('revert');
          
          if (isRevertError) {
            // Extract revert reason if available
            const reasonMatch = errorMsg.match(/reason="([^"]+)"/);
            const revertReason = reasonMatch ? reasonMatch[1] : 'Unknown revert reason';
            
            this.logger.error('Gas estimation failed with revert - transaction will fail. Reason: ${revertReason}', new Error(errorMsg.slice(0, 200)));
            throw new Error(`Transaction would revert: ${revertReason}`);
          }

          this.logger.warn('Gas estimation failed (non-revert), using default', new Error(errorMsg.slice(0, 200)));
          gasLimit = this.config.defaultGasLimit;
        }
      }

      // Build gas params (use provided or fetch current)
      const gasParams = await this.buildGasParams(gasLimit);
      if (callData.gasParams?.maxFeePerGas) {
        gasParams.maxFeePerGas = callData.gasParams.maxFeePerGas;
      }
      if (callData.gasParams?.maxPriorityFeePerGas) {
        gasParams.maxPriorityFeePerGas = callData.gasParams.maxPriorityFeePerGas;
      }

      // Build transaction
      const tx: ethers.TransactionRequest = {
        to: callData.to,
        data: callData.data,
        value: callData.value ?? BigInt(0),
        nonce,
        maxFeePerGas: gasParams.maxFeePerGas,
        maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
        gasLimit: gasParams.gasLimit,
        chainId: this.configService.web3.chainId,
      };

      this.logger.info('Sending transaction', {
        to: callData.to,
        nonce,
        gasLimit: gasParams.gasLimit?.toString(),
        maxFeeGwei: gasParams.maxFeePerGasGwei.toFixed(2),
        description: callData.description,
      });

      // Send transaction
      const txResponse = await this.wallet.sendTransaction(tx);
      const txHash = txResponse.hash;

      // Update local nonce
      this.localNonce = nonce + 1;

      // Track transaction
      const result: TxResult = {
        txHash,
        nonce,
        gasParams,
        sentAt,
        status: 'pending',
        description: callData.description,
      };

      this.trackTransaction(result);

      this.logger.info('Transaction sent', {
        txHash,
        nonce,
        description: callData.description,
      });

      return result;
    } catch (error) {
      this.logger.error('Failed to send transaction', error as Error);

      // Alert on failure
      await this.monitoringService.alertWarn('Transaction send failed', {
        component: 'TxPolicyService',
        error: error as Error,
      });

      throw error;
    }
  }

  /**
   * Wait for transaction confirmation
   */
  async waitConfirmed(
    txHash: string,
    minConfirmations?: number,
    timeoutSec?: number
  ): Promise<TxReceipt> {
    let currentTxHash = txHash;
    const confirmations = minConfirmations ?? this.config.minConfirmations;
    const timeout = (timeoutSec ?? this.config.confirmationTimeoutSec) * 1000;
    let startTime = Date.now();

    this.logger.debug('Waiting for confirmation', {
      txHash,
      confirmations,
      timeoutSec: timeout / 1000,
    });

    while (true) {
      const now = Date.now();
      const entry = this.txHistory.get(currentTxHash);
      if (entry?.result.status === 'pending') {
        const ageMs = now - entry.result.sentAt;
        if (ageMs >= this.config.stuckThresholdMs) {
          try {
            entry.result.status = 'stuck';
            entry.updatedAt = now;

            const replacement = await this.bumpAndReplace(currentTxHash);
            await this.monitoringService.alertWarn('Transaction stuck, sent replacement', {
              component: 'TxPolicyService',
              context: {
                originalTxHash: currentTxHash,
                replacementTxHash: replacement.txHash,
                nonce: replacement.nonce,
                ageMs,
              },
            });

            currentTxHash = replacement.txHash;
            startTime = Date.now();
            continue;
          } catch (error) {
            await this.monitoringService.alertCritical('Transaction stuck, replacement failed', {
              component: 'TxPolicyService',
              error: error as Error,
              context: {
                txHash: currentTxHash,
                ageMs,
              },
            });
            throw error;
          }
        }
      }

      // Check timeout
      if (Date.now() - startTime > timeout) {
        const timedOutEntry = this.txHistory.get(currentTxHash);
        if (timedOutEntry?.result.status === 'pending') {
          try {
            const replacement = await this.bumpAndReplace(currentTxHash);
            await this.monitoringService.alertWarn('Transaction timeout, sent replacement', {
              component: 'TxPolicyService',
              context: {
                originalTxHash: currentTxHash,
                replacementTxHash: replacement.txHash,
                nonce: replacement.nonce,
              },
            });
            currentTxHash = replacement.txHash;
            startTime = Date.now();
            continue;
          } catch (error) {
            await this.monitoringService.alertCritical('Transaction timeout, replacement failed', {
              component: 'TxPolicyService',
              error: error as Error,
              context: { txHash: currentTxHash, timeoutSec: timeout / 1000 },
            });
            throw error;
          }
        }
        if (timedOutEntry) {
          timedOutEntry.result.status = 'timeout';
          timedOutEntry.updatedAt = Date.now();
        }

        await this.monitoringService.alertCritical('Transaction stuck (timeout)', {
          component: 'TxPolicyService',
          context: { txHash, timeoutSec: timeout / 1000 },
        });

        throw new Error(`Transaction timeout after ${timeout / 1000}s: ${currentTxHash}`);
      }

      try {
        const receipt = await this.provider.getTransactionReceipt(currentTxHash);

        if (receipt) {
          const currentBlock = await this.provider.getBlockNumber();
          const txConfirmations = currentBlock - receipt.blockNumber + 1;

          if (txConfirmations >= confirmations) {
            const costEth = new Decimal(
              (receipt.gasUsed * receipt.gasPrice).toString()
            ).div(1e18);

            const txReceipt: TxReceipt = {
              txHash: currentTxHash,
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash,
              confirmations: txConfirmations,
              gasUsed: receipt.gasUsed,
              effectiveGasPrice: receipt.gasPrice,
              status: receipt.status ?? 0,
              costEth,
              confirmedAt: Date.now(),
              logs: receipt.logs,
            };

            // Update tracking
            const confirmedEntry = this.txHistory.get(currentTxHash);
            if (confirmedEntry) {
              confirmedEntry.result.status = receipt.status === 1 ? 'confirmed' : 'failed';
              confirmedEntry.receipt = txReceipt;
              confirmedEntry.updatedAt = Date.now();

              // Remove from pending by nonce
              this.pendingByNonce.delete(confirmedEntry.result.nonce);
            }

            this.logger.info('Transaction confirmed', {
              txHash: currentTxHash,
              blockNumber: receipt.blockNumber,
              status: receipt.status === 1 ? 'success' : 'reverted',
              gasUsed: receipt.gasUsed.toString(),
              costEth: costEth.toFixed(6),
            });

            if (receipt.status === 0) {
              await this.monitoringService.alertWarn('Transaction reverted', {
                component: 'TxPolicyService',
                context: { txHash, blockNumber: receipt.blockNumber },
              });
            }

            return txReceipt;
          }
        }
      } catch (e) {
        this.logger.debug('Receipt check failed, retrying...', { error: (e as Error).message });
      }

      // Wait before next poll
      await this.sleep(this.config.pollingIntervalMs);
    }
  }

  /**
   * Bump gas and replace stuck transaction
   */
  async bumpAndReplace(txHash: string): Promise<TxResult> {
    const entry = this.txHistory.get(txHash);

    if (!entry) {
      throw new Error(`Transaction not found: ${txHash}`);
    }

    if (entry.result.status !== 'pending') {
      throw new Error(`Transaction is not pending: ${txHash}, status: ${entry.result.status}`);
    }

    // Check replacement attempts
    const attempts = this.countReplacementAttempts(entry.result.nonce);
    if (attempts >= this.config.maxReplacementAttempts) {
      throw new Error(`Max replacement attempts (${this.config.maxReplacementAttempts}) reached for nonce ${entry.result.nonce}`);
    }

    this.logger.info('Bumping and replacing transaction', {
      originalTxHash: txHash,
      nonce: entry.result.nonce,
      attempt: attempts + 1,
    });

    // Calculate bumped gas params
    const bumpMultiplier = new Decimal(1).add(this.config.gasBumpPercent);
    const newMaxFeePerGas = BigInt(
      new Decimal(entry.result.gasParams.maxFeePerGas.toString())
        .mul(bumpMultiplier)
        .floor()
        .toString()
    );
    const newMaxPriorityFeePerGas = BigInt(
      new Decimal(entry.result.gasParams.maxPriorityFeePerGas.toString())
        .mul(bumpMultiplier)
        .floor()
        .toString()
    );

    // We need to reconstruct the original call to replace it
    // For replacement, we send a minimal tx with same nonce
    // In a real scenario, we'd store the original callData

    // Get the original transaction to extract details
    const originalTx = await this.provider.getTransaction(txHash);
    if (!originalTx) {
      throw new Error(`Cannot find original transaction: ${txHash}`);
    }

    const replacementTx: ethers.TransactionRequest = {
      to: originalTx.to,
      data: originalTx.data,
      value: originalTx.value,
      nonce: entry.result.nonce,
      maxFeePerGas: newMaxFeePerGas,
      maxPriorityFeePerGas: newMaxPriorityFeePerGas,
      gasLimit: originalTx.gasLimit,
      chainId: this.configService.web3.chainId,
    };

    // Send replacement
    const txResponse = await this.wallet.sendTransaction(replacementTx);
    const newTxHash = txResponse.hash;

    // Update old entry as replaced
    entry.result.status = 'replaced';
    entry.updatedAt = Date.now();

    // Create new tracking entry
    const newGasParams: GasParams = {
      ...entry.result.gasParams,
      maxFeePerGas: newMaxFeePerGas,
      maxPriorityFeePerGas: newMaxPriorityFeePerGas,
      maxFeePerGasGwei: new Decimal(newMaxFeePerGas.toString()).div(1e9),
      maxPriorityFeeGwei: new Decimal(newMaxPriorityFeePerGas.toString()).div(1e9),
      timestamp: Date.now(),
    };

    const newResult: TxResult = {
      txHash: newTxHash,
      nonce: entry.result.nonce,
      gasParams: newGasParams,
      sentAt: Date.now(),
      status: 'pending',
      description: `Replacement for ${txHash}`,
    };

    entry.replacementTx = newResult;
    this.trackTransaction(newResult);

    this.logger.info('Transaction replaced', {
      originalTxHash: txHash,
      newTxHash,
      nonce: entry.result.nonce,
      newMaxFeeGwei: newGasParams.maxFeePerGasGwei.toFixed(2),
    });

    return newResult;
  }

  // ==================== Helper Methods ====================

  /**
   * Get nonce info for wallet
   */
  async getNonceInfo(wallet?: string): Promise<NonceInfo> {
    const address = wallet || this.wallet.address;

    const [confirmed, pending] = await Promise.all([
      this.provider.getTransactionCount(address, 'latest'),
      this.provider.getTransactionCount(address, 'pending'),
    ]);

    const inFlightTxs = new Map<number, string>();
    for (const [txHash, entry] of this.txHistory) {
      if (entry.result.status === 'pending') {
        inFlightTxs.set(entry.result.nonce, txHash);
      }
    }

    return {
      wallet: address,
      confirmedNonce: confirmed,
      pendingNonce: pending,
      inFlightTxs,
      lastUpdate: Date.now(),
    };
  }

  /**
   * Get stuck transactions
   */
  getStuckTransactions(): StuckTxInfo[] {
    const now = Date.now();
    const stuck: StuckTxInfo[] = [];

    for (const [txHash, entry] of this.txHistory) {
      if (entry.result.status !== 'pending') continue;

      const ageMs = now - entry.result.sentAt;
      if (ageMs >= this.config.stuckThresholdMs) {
        stuck.push({
          txHash,
          nonce: entry.result.nonce,
          ageMs,
          originalGasParams: entry.result.gasParams,
          replacementAttempts: this.countReplacementAttempts(entry.result.nonce),
        });
      }
    }

    return stuck.sort((a, b) => b.ageMs - a.ageMs);
  }

  /**
   * Count replacement attempts for a nonce
   */
  private countReplacementAttempts(nonce: number): number {
    let count = 0;
    for (const entry of this.txHistory.values()) {
      if (entry.result.nonce === nonce && entry.result.status === 'replaced') {
        count++;
      }
    }
    return count;
  }

  /**
   * Get transaction tracking entry
   */
  getTransaction(txHash: string): TxTrackingEntry | undefined {
    return this.txHistory.get(txHash);
  }

  /**
   * Get all pending transactions
   */
  getPendingTransactions(): TxTrackingEntry[] {
    const pending: TxTrackingEntry[] = [];
    for (const entry of this.txHistory.values()) {
      if (entry.result.status === 'pending') {
        pending.push(entry);
      }
    }
    return pending.sort((a, b) => a.result.nonce - b.result.nonce);
  }

  /**
   * Cancel pending transaction
   */
  async cancelTransaction(nonce: number): Promise<TxResult> {
    this.logger.info('Cancelling transaction', { nonce });

    // Send 0 ETH to self with same nonce and higher gas
    const gasParams = await this.buildGasParams(BigInt(21000));

    // Bump gas to ensure replacement
    const bumpedMaxFee = BigInt(
      new Decimal(gasParams.maxFeePerGas.toString()).mul(1.5).floor().toString()
    );
    const bumpedPriorityFee = BigInt(
      new Decimal(gasParams.maxPriorityFeePerGas.toString()).mul(1.5).floor().toString()
    );

    const cancelTx: ethers.TransactionRequest = {
      to: this.wallet.address,
      value: BigInt(0),
      nonce,
      maxFeePerGas: bumpedMaxFee,
      maxPriorityFeePerGas: bumpedPriorityFee,
      gasLimit: BigInt(21000),
      chainId: this.configService.web3.chainId,
    };

    const txResponse = await this.wallet.sendTransaction(cancelTx);

    const result: TxResult = {
      txHash: txResponse.hash,
      nonce,
      gasParams: {
        ...gasParams,
        maxFeePerGas: bumpedMaxFee,
        maxPriorityFeePerGas: bumpedPriorityFee,
      },
      sentAt: Date.now(),
      status: 'pending',
      description: `Cancel nonce ${nonce}`,
    };

    // Mark original as replaced
    const originalTxHash = this.pendingByNonce.get(nonce);
    if (originalTxHash) {
      const entry = this.txHistory.get(originalTxHash);
      if (entry) {
        entry.result.status = 'replaced';
        entry.updatedAt = Date.now();
      }
    }

    this.trackTransaction(result);

    return result;
  }

  /**
   * Estimate gas for call data
   */
  async estimateGas(callData: TxCallData): Promise<bigint> {
    const estimate = await this.provider.estimateGas({
      to: callData.to,
      data: callData.data,
      value: callData.value ?? BigInt(0),
      from: this.wallet.address,
    });

    return estimate;
  }

  // ==================== Tracking ====================

  /**
   * Track a transaction
   */
  private trackTransaction(result: TxResult): void {
    const entry: TxTrackingEntry = {
      result,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.txHistory.set(result.txHash, entry);
    this.pendingByNonce.set(result.nonce, result.txHash);
  }

  // ==================== Configuration ====================

  getConfig(): TxPolicyConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<TxPolicyConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('TxPolicy config updated', config);
  }

  clearHistory(): void {
    this.txHistory.clear();
    this.pendingByNonce.clear();
    this.logger.info('Transaction history cleared');
  }

  async resetNonceTracking(wallet?: string): Promise<void> {
    this.nonceInitialized = false;
    this.localNonce = -1;
    await this.getNextNonce(wallet);
    this.logger.info('Nonce tracking reset');
  }

  // ==================== Utilities ====================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
