import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';
import { ethers } from 'ethers';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { EventBus } from '../../infra/event-bus/event-bus';
import type { ITxPolicyService } from '../tx-policy';
import type { IMonitoringService } from '../monitoring';
import { IWalletService } from './wallet.interface';
import {
  Balances,
  AllowanceResult,
  RebalanceResult,
  RebalanceParams,
  WalletServiceConfig,
  SwapPolicyConfig,
  TokenInfo,
  SwapResult,
  SwapDirection,
} from './wallet.types';

// ERC20 ABI (minimal)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// WETH ABI (includes deposit/withdraw)
const WETH_ABI = [
  ...ERC20_ABI,
  'function deposit() payable',
  'function withdraw(uint256 wad)',
];

// Uniswap V3 SwapRouter ABI (minimal)
const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

// Max uint256 for unlimited approval
const MAX_UINT256 = ethers.MaxUint256;

/**
 * Default wallet service configuration
 */
const DEFAULT_CONFIG: WalletServiceConfig = {
  defaultSlippageBps: 50, // 0.5%
  maxSlippageBps: 300, // 3%
  minEthForGas: new Decimal('0.01'), // 0.01 ETH
  approvalAmount: 'max',
  deadlineBufferSeconds: 1800, // 30 minutes
  minRebalanceThresholdPercent: new Decimal(2), // 2% deviation
};

/**
 * Wallet Service
 * Manages wallet on selected network: balances, approvals, swaps for 50/50 rebalance
 */
@injectable()
export class WalletService implements IWalletService {
  private readonly logger: ILogger;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly wallet: ethers.Wallet;
  private config: WalletServiceConfig;

  // Token contracts
  private usdcContract: ethers.Contract;
  private wethContract: ethers.Contract;
  private swapRouterContract: ethers.Contract;

  // Token info cache
  private tokenInfoCache: Map<string, TokenInfo> = new Map();

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE) private readonly configService: ConfigService,
    @inject(TOKENS.TX_POLICY_SERVICE) private readonly txPolicyService: ITxPolicyService,
    @inject(TOKENS.MONITORING_SERVICE) private readonly monitoringService: IMonitoringService,
    @inject(TOKENS.EVENT_BUS) private readonly eventBus: EventBus
  ) {
    this.logger = logger.child('WalletService');

    // Initialize provider and wallet
    this.provider = new ethers.JsonRpcProvider(this.configService.web3.rpcUrl);
    this.wallet = new ethers.Wallet(this.configService.web3.privateKey, this.provider);

    // Initialize config
    this.config = {
      ...DEFAULT_CONFIG,
      defaultSlippageBps: this.configService.web3.defaultSlippageTolerance * 100,
    };

    // Initialize contracts
    const { pool, web3 } = this.configService;

    this.usdcContract = new ethers.Contract(pool.token1Address, ERC20_ABI, this.wallet);
    this.wethContract = new ethers.Contract(pool.token0Address, WETH_ABI, this.wallet);
    this.swapRouterContract = new ethers.Contract(
      web3.swapRouterAddress,
      SWAP_ROUTER_ABI,
      this.wallet
    );

    // Cache token info
    this.tokenInfoCache.set(pool.token0Address.toLowerCase(), {
      address: pool.token0Address,
      symbol: pool.token0Symbol,
      decimals: pool.token0Decimals,
    });
    this.tokenInfoCache.set(pool.token1Address.toLowerCase(), {
      address: pool.token1Address,
      symbol: pool.token1Symbol,
      decimals: pool.token1Decimals,
    });

    this.logger.info('WalletService initialized', {
      wallet: this.wallet.address,
      weth: pool.token0Address,
      usdc: pool.token1Address,
    });
  }

  // ==================== Balance Methods ====================

  /**
   * Get current token balances
   */
  async getBalances(): Promise<Balances> {
    try {
      const { pool } = this.configService;

      // Fetch all balances in parallel
      const [usdcRaw, wethRaw, ethRaw] = await Promise.all([
        this.usdcContract.balanceOf(this.wallet.address),
        this.wethContract.balanceOf(this.wallet.address),
        this.provider.getBalance(this.wallet.address),
      ]);

      // Convert to human-readable
      const usdc = new Decimal(usdcRaw.toString()).div(new Decimal(10).pow(pool.token1Decimals));
      const weth = new Decimal(wethRaw.toString()).div(new Decimal(10).pow(pool.token0Decimals));
      const ethForGas = new Decimal(ethRaw.toString()).div(new Decimal(10).pow(18));

      const balances: Balances = {
        usdc,
        weth,
        ethForGas,
        timestamp: Date.now(),
      };

      this.logger.debug('Balances fetched', {
        usdc: usdc.toFixed(2),
        weth: weth.toFixed(6),
        ethForGas: ethForGas.toFixed(6),
      });

      // Check gas warning
      if (ethForGas.lessThan(this.config.minEthForGas)) {
        await this.monitoringService.alertWarn('Low ETH for gas', {
          component: 'WalletService',
          context: {
            ethForGas: ethForGas.toFixed(6),
            minimum: this.config.minEthForGas.toFixed(6),
          },
        });
      }

      return balances;
    } catch (error) {
      this.logger.error('Failed to get balances', error as Error);
      throw error;
    }
  }

  /**
   * Get balances with value calculations
   */
  async getBalancesWithValue(referencePrice: Decimal): Promise<Balances> {
    const balances = await this.getBalances();

    // Calculate values
    const wethValueUsdc = balances.weth.mul(referencePrice);
    const totalValueUsdc = balances.usdc.add(wethValueUsdc);

    // Calculate percentages
    const wethPercent = totalValueUsdc.isZero()
      ? new Decimal(0)
      : wethValueUsdc.div(totalValueUsdc).mul(100);
    const usdcPercent = totalValueUsdc.isZero()
      ? new Decimal(0)
      : balances.usdc.div(totalValueUsdc).mul(100);

    return {
      ...balances,
      totalValueUsdc,
      wethValueUsdc,
      wethPercent,
      usdcPercent,
    };
  }

  // ==================== Allowance Methods ====================

  /**
   * Get current allowance for token/spender
   */
  async getAllowance(token: string, spender: string): Promise<Decimal> {
    const tokenInfo = this.getTokenInfo(token);
    const contract = new ethers.Contract(token, ERC20_ABI, this.provider);

    const allowanceRaw = await contract.allowance(this.wallet.address, spender);
    return new Decimal(allowanceRaw.toString()).div(new Decimal(10).pow(tokenInfo.decimals));
  }

  /**
   * Ensure token allowance is sufficient
   */
  async ensureAllowance(
    token: string,
    spender: string,
    minAmount: Decimal
  ): Promise<AllowanceResult> {
    try {
      const tokenInfo = this.getTokenInfo(token);

      this.logger.debug('Checking allowance', {
        token: tokenInfo.symbol,
        spender,
        required: minAmount.toFixed(6),
      });

      // Check current allowance
      const currentAllowance = await this.getAllowance(token, spender);

      // If sufficient, return
      if (currentAllowance.greaterThanOrEqualTo(minAmount)) {
        this.logger.debug('Allowance sufficient', {
          token: tokenInfo.symbol,
          current: currentAllowance.toFixed(6),
          required: minAmount.toFixed(6),
        });

        return {
          ok: true,
          currentAllowance,
          requiredAmount: minAmount,
          approvalMade: false,
          token,
          spender,
        };
      }

      // Need to approve
      this.logger.info('Approving token', {
        token: tokenInfo.symbol,
        spender,
        amount: this.config.approvalAmount === 'max' ? 'unlimited' : minAmount.toFixed(6),
      });

      const txHash = await this.approve(token, spender, this.config.approvalAmount);

      // Wait for confirmation
      await this.txPolicyService.waitConfirmed(txHash);

      // Get new allowance
      const newAllowance = await this.getAllowance(token, spender);

      this.logger.info('Token approved', {
        token: tokenInfo.symbol,
        txHash,
        newAllowance: newAllowance.toFixed(6),
      });

      return {
        ok: true,
        currentAllowance,
        requiredAmount: minAmount,
        approvalMade: true,
        txHash,
        newAllowance,
        token,
        spender,
      };
    } catch (error) {
      this.logger.error('Failed to ensure allowance', error as Error);

      await this.monitoringService.alertWarn('Approval failed', {
        component: 'WalletService',
        error: error as Error,
        context: { token, spender },
      });

      return {
        ok: false,
        currentAllowance: new Decimal(0),
        requiredAmount: minAmount,
        approvalMade: false,
        token,
        spender,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Approve token spending
   */
  async approve(token: string, spender: string, amount: Decimal | 'max'): Promise<string> {
    const tokenInfo = this.getTokenInfo(token);
    const contract = new ethers.Contract(token, ERC20_ABI, this.wallet);

    // Calculate amount in raw units
    let amountRaw: bigint;
    if (amount === 'max') {
      amountRaw = MAX_UINT256;
    } else {
      amountRaw = BigInt(amount.mul(new Decimal(10).pow(tokenInfo.decimals)).floor().toString());
    }

    // Encode call data
    const data = contract.interface.encodeFunctionData('approve', [spender, amountRaw]);

    // Send via TxPolicyService
    const result = await this.txPolicyService.sendTx({
      to: token,
      data,
      description: `Approve ${tokenInfo.symbol} for ${spender}`,
    });

    return result.txHash;
  }

  // ==================== Swap Methods ====================

  /**
   * Swap tokens via Uniswap V3 router
   */
  async swap(
    tokenIn: string,
    tokenOut: string,
    amountIn: Decimal,
    minAmountOut: Decimal
  ): Promise<string> {
    const tokenInInfo = this.getTokenInfo(tokenIn);
    const tokenOutInfo = this.getTokenInfo(tokenOut);
    const { pool, web3 } = this.configService;

    // Convert to raw units
    const amountInRaw = BigInt(
      amountIn.mul(new Decimal(10).pow(tokenInInfo.decimals)).floor().toString()
    );
    const amountOutMinRaw = BigInt(
      minAmountOut.mul(new Decimal(10).pow(tokenOutInfo.decimals)).floor().toString()
    );

    // Build deadline
    const deadline = Math.floor(Date.now() / 1000) + this.config.deadlineBufferSeconds;

    // Encode exactInputSingle call
    const params = {
      tokenIn,
      tokenOut,
      fee: pool.feeTier,
      recipient: this.wallet.address,
      deadline,
      amountIn: amountInRaw,
      amountOutMinimum: amountOutMinRaw,
      sqrtPriceLimitX96: BigInt(0), // No price limit
    };

    const data = this.swapRouterContract.interface.encodeFunctionData('exactInputSingle', [params]);

    this.logger.info('Executing swap', {
      tokenIn: tokenInInfo.symbol,
      tokenOut: tokenOutInfo.symbol,
      amountIn: amountIn.toFixed(6),
      minAmountOut: minAmountOut.toFixed(6),
    });

    // Block real swaps in simulation mode
    if (this.configService.isSimulationMode()) {
      this.logger.info('Simulation mode: skipping actual swap');
      return '0x_simulation_tx';
    }

    // Send via TxPolicyService
    const result = await this.txPolicyService.sendTx({
      to: web3.swapRouterAddress,
      data,
      description: `Swap ${amountIn.toFixed(4)} ${tokenInInfo.symbol} → ${tokenOutInfo.symbol}`,
    });

    return result.txHash;
  }

  // ==================== Rebalance to 50/50 ====================

  /**
   * Rebalance holdings to approximately 50/50 WETH/USDC (per spec 2.1)
   *
   * Called after collect() to prepare for mint() by bringing assets
   * closer to 50/50 by value.
   *
   * @param params - Rebalance parameters
   * @returns RebalanceResult with full details
   */
  async rebalanceTo50_50(params: RebalanceParams): Promise<RebalanceResult>;

  /**
   * Legacy signature for backward compatibility
   */
  async rebalanceTo50_50(
    targetTotalUsdc: Decimal,
    referencePrice: Decimal,
    maxSlippageBps?: number
  ): Promise<RebalanceResult>;

  async rebalanceTo50_50(
    paramsOrTargetTotal: RebalanceParams | Decimal,
    referencePrice?: Decimal,
    maxSlippageBps?: number
  ): Promise<RebalanceResult> {
    // Normalize to new params format
    let params: RebalanceParams;

    if (paramsOrTargetTotal instanceof Decimal) {
      // Legacy call signature
      params = {
        referencePrice: referencePrice!,
        deviationThresholdPct: this.config.minRebalanceThresholdPercent.div(100).toNumber(),
        maxSlippageBps: maxSlippageBps ?? this.config.defaultSlippageBps,
        deadlineSec: this.config.deadlineBufferSeconds,
        dryRun: false,
      };
    } else {
      params = paramsOrTargetTotal;
    }

    const {
      referencePrice: refPrice,
      deviationThresholdPct,
      maxSlippageBps: slippageBps,
      deadlineSec,
      minNotionalUsdc,
      dryRun,
    } = params;

    // Get swap policy from config
    const swapPolicy = this.getSwapPolicy();

    try {
      this.logger.info('Starting 50/50 rebalance', {
        referencePrice: refPrice.toFixed(2),
        deviationThreshold: `${(deviationThresholdPct * 100).toFixed(1)}%`,
        slippageBps,
        dryRun,
      });

      // Step 1: Get current balances
      const balancesBefore = await this.getBalancesWithValue(refPrice);

      // Step 2: Calculate values
      const wethValueUsdc = balancesBefore.weth.mul(refPrice);
      const totalUsdc = balancesBefore.usdc.add(wethValueUsdc);
      
      // Target WETH value - use custom ratio if provided, otherwise 50%
      const targetWethPct = params.targetWethPercent ?? 50;
      const targetWethValue = totalUsdc.mul(targetWethPct).div(100);

      // Step 3: Check deviation from target
      const deviation = wethValueUsdc.sub(targetWethValue).abs().div(totalUsdc);
      const deviationPct = deviation.toNumber();

      this.logger.debug('Rebalance analysis', {
        wethValueUsdc: wethValueUsdc.toFixed(2),
        usdcBalance: balancesBefore.usdc.toFixed(2),
        totalUsdc: totalUsdc.toFixed(2),
        targetWethValue: targetWethValue.toFixed(2),
        targetWethPct: `${targetWethPct}%`,
        deviation: `${(deviationPct * 100).toFixed(2)}%`,
        threshold: `${(deviationThresholdPct * 100).toFixed(2)}%`,
      });

      // If within threshold, no swap needed
      if (deviationPct <= deviationThresholdPct) {
        const reason = `within ${(deviationThresholdPct * 100).toFixed(0)}% threshold (actual: ${(deviationPct * 100).toFixed(2)}%)`;
        this.logger.info('Rebalance not needed', { reason });

        this.eventBus.emit('rebalance.completed', {
          timestamp: Date.now(),
          performed: false,
          direction: 'NONE',
          targetWethPercent: targetWethPct,
          reason,
          balancesBefore: {
            weth: balancesBefore.weth.toFixed(6),
            usdc: balancesBefore.usdc.toFixed(2),
            wethPercent: (wethValueUsdc.div(totalUsdc).mul(100)).toFixed(1),
          },
        });

        return {
          performed: false,
          direction: 'NONE',
          balancesBefore,
          balancesAfter: balancesBefore,
          reason,
          deviationPercentBefore: deviation.mul(100),
          rebalanceNeeded: false,
          success: true,
          targetWethValue,
          actualWethValue: wethValueUsdc,
          deviationPercent: deviation.mul(100),
        };
      }

      // Step 4: Determine direction and amounts
      let direction: SwapDirection;
      let amountIn: Decimal;
      let amountOutMin: Decimal;
      let tokenIn: string;
      let tokenOut: string;
      const { pool } = this.configService;
      const delta = wethValueUsdc.sub(targetWethValue).abs();

      // Check min notional
      const minNotionalThreshold = minNotionalUsdc ?? swapPolicy.minNotionalUsdc;
      if (delta.lt(minNotionalThreshold)) {
        const reason = `delta ${delta.toFixed(2)} < minNotional ${minNotionalThreshold}`;
        this.logger.info('Swap skipped - below min notional', { reason, delta: delta.toFixed(2) });

        this.eventBus.emit('rebalance.completed', {
          timestamp: Date.now(),
          performed: false,
          direction: 'NONE',
          targetWethPercent: targetWethPct,
          reason,
          balancesBefore: {
            weth: balancesBefore.weth.toFixed(6),
            usdc: balancesBefore.usdc.toFixed(2),
            wethPercent: (wethValueUsdc.div(totalUsdc).mul(100)).toFixed(1),
          },
        });

        return {
          performed: false,
          direction: 'NONE',
          balancesBefore,
          balancesAfter: balancesBefore,
          reason,
          deviationPercentBefore: deviation.mul(100),
          rebalanceNeeded: true,
          success: true,
          targetWethValue,
          actualWethValue: wethValueUsdc,
          deviationPercent: deviation.mul(100),
        };
      }

      if (wethValueUsdc.gt(targetWethValue)) {
        // Too much WETH → sell WETH for USDC
        direction = 'WETH_TO_USDC';
        tokenIn = pool.token0Address;
        tokenOut = pool.token1Address;
        amountIn = delta.div(refPrice); // WETH amount
        // amountOutMin = delta * (1 - slippage)
        amountOutMin = delta.mul(new Decimal(10000 - slippageBps).div(10000));
      } else {
        // Too little WETH → buy WETH with USDC
        direction = 'USDC_TO_WETH';
        tokenIn = pool.token1Address;
        tokenOut = pool.token0Address;
        amountIn = delta; // USDC amount
        // amountOutMin = (delta / price) * (1 - slippage)
        const targetWethAmount = delta.div(refPrice);
        amountOutMin = targetWethAmount.mul(new Decimal(10000 - slippageBps).div(10000));
      }

      this.logger.info('Swap plan computed', {
        direction,
        amountIn: amountIn.toFixed(6),
        amountOutMin: amountOutMin.toFixed(6),
        dryRun,
      });

      // If dry run, return plan without executing
      if (dryRun) {
        return {
          performed: false,
          direction,
          amountIn,
          amountOutMin,
          balancesBefore,
          reason: 'dry run - no tx sent',
          deviationPercentBefore: deviation.mul(100),
          rebalanceNeeded: true,
          success: true,
          targetWethValue: targetWethValue,
        };
      }

      // Block real swaps in simulation mode
      if (this.configService.isSimulationMode()) {
        this.logger.info('Simulation mode: skipping actual swap');
        return {
          performed: false,
          direction,
          amountIn,
          amountOutMin,
          balancesBefore,
          reason: 'simulation mode - no real swap',
          deviationPercentBefore: deviation.mul(100),
          rebalanceNeeded: true,
          success: true,
          targetWethValue: targetWethValue,
        };
      }

      // Step 6: Ensure allowance
      const allowanceResult = await this.ensureAllowance(
        tokenIn,
        this.configService.web3.swapRouterAddress,
        amountIn
      );
      if (!allowanceResult.ok) {
        throw new Error(`Approval failed: ${allowanceResult.error}`);
      }

      // Step 7-9: Execute swap via internal helper
      const swapResult = await this.swapExactInputSingle({
        tokenIn,
        tokenOut,
        amountIn,
        amountOutMin,
        deadlineSec,
        slippageBps,
      });

      if (!swapResult.success) {
        throw new Error(swapResult.error || 'Swap failed');
      }

      // Step 10: Get balances after
      const balancesAfter = await this.getBalancesWithValue(refPrice);
      const actualWethValue = balancesAfter.weth.mul(refPrice);
      const finalDeviation = actualWethValue.sub(targetWethValue).abs().div(
        balancesAfter.totalValueUsdc || totalUsdc
      );

      this.logger.info('Rebalance complete', {
        direction,
        amountIn: amountIn.toFixed(6),
        txHash: swapResult.txHash,
        wethPercentAfter: balancesAfter.wethPercent?.toFixed(2),
        usdcPercentAfter: balancesAfter.usdcPercent?.toFixed(2),
      });

      // Emit success event
      this.eventBus.emit('rebalance.completed', {
        timestamp: Date.now(),
        performed: true,
        direction,
        targetWethPercent: targetWethPct,
        amountIn: amountIn.toFixed(6),
        amountOut: swapResult.amountOut?.toFixed(6),
        txHash: swapResult.txHash,
        reason: `rebalanced ${direction}`,
        balancesBefore: {
          weth: balancesBefore.weth.toFixed(6),
          usdc: balancesBefore.usdc.toFixed(2),
          wethPercent: (wethValueUsdc.div(totalUsdc).mul(100)).toFixed(1),
        },
        balancesAfter: {
          weth: balancesAfter.weth.toFixed(6),
          usdc: balancesAfter.usdc.toFixed(2),
          wethPercent: (balancesAfter.wethPercent ?? new Decimal(0)).toFixed(1),
        },
      });

      return {
        performed: true,
        direction,
        amountIn,
        amountOutMin,
        amountOut: swapResult.amountOut,
        txHash: swapResult.txHash,
        balancesBefore,
        balancesAfter,
        reason: `rebalanced ${direction}`,
        deviationPercentBefore: deviation.mul(100),
        rebalanceNeeded: true,
        success: true,
        swap: swapResult,
        targetWethValue: targetWethValue,
        actualWethValue,
        deviationPercent: finalDeviation.mul(100),
      };
    } catch (error) {
      this.logger.error('Rebalance failed', error as Error);

      await this.monitoringService.alertCritical('50/50 rebalance failed', {
        component: 'WalletService',
        error: (error as Error).message,
      });

      const balancesBeforeErr = await this.getBalancesWithValue(refPrice).catch(() => ({
        usdc: new Decimal(0),
        weth: new Decimal(0),
        ethForGas: new Decimal(0),
        timestamp: Date.now(),
      }));

      // Emit error event
      this.eventBus.emit('rebalance.completed', {
        timestamp: Date.now(),
        performed: false,
        direction: 'NONE',
        targetWethPercent: params.targetWethPercent ?? 50,
        reason: `error: ${(error as Error).message}`,
        balancesBefore: {
          weth: balancesBeforeErr.weth.toFixed(6),
          usdc: balancesBeforeErr.usdc.toFixed(2),
          wethPercent: '0',
        },
        error: (error as Error).message,
      });

      return {
        performed: false,
        direction: 'NONE',
        balancesBefore: balancesBeforeErr,
        reason: `error: ${(error as Error).message}`,
        rebalanceNeeded: true,
        success: false,
        error: (error as Error).message,
        targetWethValue: new Decimal(0),
      };
    }
  }

  // ==================== Internal Swap Helper (per spec 2.2) ====================

  /**
   * Execute exactInputSingle swap via Uniswap V3 router
   * Internal helper used by rebalanceTo50_50 and emergency conversions
   */
  private async swapExactInputSingle(params: {
    tokenIn: string;
    tokenOut: string;
    amountIn: Decimal;
    amountOutMin: Decimal;
    deadlineSec: number;
    slippageBps: number;
  }): Promise<SwapResult> {
    const { tokenIn, tokenOut, amountIn, amountOutMin, deadlineSec, slippageBps } = params;
    const tokenInInfo = this.getTokenInfo(tokenIn);
    const tokenOutInfo = this.getTokenInfo(tokenOut);
    const { pool, web3 } = this.configService;

    // Convert to raw units
    const amountInRaw = BigInt(
      amountIn.mul(new Decimal(10).pow(tokenInInfo.decimals)).floor().toString()
    );
    const amountOutMinRaw = BigInt(
      amountOutMin.mul(new Decimal(10).pow(tokenOutInfo.decimals)).floor().toString()
    );

    // Build deadline
    const deadline = Math.floor(Date.now() / 1000) + deadlineSec;

    // Encode exactInputSingle call
    const routerParams = {
      tokenIn,
      tokenOut,
      fee: pool.feeTier,
      recipient: this.wallet.address,
      deadline,
      amountIn: amountInRaw,
      amountOutMinimum: amountOutMinRaw,
      sqrtPriceLimitX96: BigInt(0), // No price limit
    };

    const data = this.swapRouterContract.interface.encodeFunctionData('exactInputSingle', [routerParams]);

    const direction: SwapDirection = tokenIn === pool.token0Address ? 'WETH_TO_USDC' : 'USDC_TO_WETH';

    this.logger.info('Executing swap', {
      direction,
      tokenIn: tokenInInfo.symbol,
      tokenOut: tokenOutInfo.symbol,
      amountIn: amountIn.toFixed(6),
      minAmountOut: amountOutMin.toFixed(6),
    });

    try {
      // Send via TxPolicyService
      const result = await this.txPolicyService.sendTx({
        to: web3.swapRouterAddress,
        data,
        description: `Swap ${amountIn.toFixed(4)} ${tokenInInfo.symbol} → ${tokenOutInfo.symbol}`,
      });

      // Wait for confirmation
      const receipt = await this.txPolicyService.waitConfirmed(result.txHash);

      // Calculate effective price (approximate - would need to parse logs for exact)
      const effectivePrice = direction === 'WETH_TO_USDC'
        ? amountOutMin.div(amountIn)
        : amountIn.div(amountOutMin);

      return {
        success: receipt.status === 1,
        direction,
        amountIn,
        amountOut: amountOutMin, // Approximate (actual from logs would be better)
        effectivePrice,
        slippageBps: new Decimal(slippageBps),
        txHash: result.txHash,
        gasUsed: new Decimal(receipt.gasUsed.toString()),
      };
    } catch (error) {
      this.logger.error('Swap failed', error as Error);

      return {
        success: false,
        direction,
        amountIn,
        amountOut: new Decimal(0),
        effectivePrice: new Decimal(0),
        slippageBps: new Decimal(slippageBps),
        txHash: '',
        error: (error as Error).message,
      };
    }
  }

  /**
   * Get swap policy from config
   */
  private getSwapPolicy(): SwapPolicyConfig {
    // Try to get from configService.swapPolicy if available
    const configSwapPolicy = (this.configService as any).swapPolicy;

    if (configSwapPolicy) {
      return {
        enabled: configSwapPolicy.enabled ?? true,
        deviationThresholdPct: configSwapPolicy.deviationThresholdPct ?? 0.05,
        maxSlippageBps: configSwapPolicy.maxSlippageBps ?? 30,
        deadlineSec: configSwapPolicy.deadlineSec ?? 120,
        minNotionalUsdc: configSwapPolicy.minNotionalUsdc ?? 200,
      };
    }

    // Default swap policy
    return {
      enabled: true,
      deviationThresholdPct: 0.05,
      maxSlippageBps: 30,
      deadlineSec: 120,
      minNotionalUsdc: 200,
    };
  }

  // ==================== WETH Wrap/Unwrap ====================

  /**
   * Wrap ETH to WETH
   */
  async wrapEth(amount: Decimal): Promise<string> {
    const amountRaw = BigInt(amount.mul(new Decimal(10).pow(18)).floor().toString());

    const data = this.wethContract.interface.encodeFunctionData('deposit');

    const result = await this.txPolicyService.sendTx({
      to: this.configService.pool.token0Address,
      data,
      value: amountRaw,
      description: `Wrap ${amount.toFixed(6)} ETH → WETH`,
    });

    // Wait for confirmation before returning
    await this.txPolicyService.waitConfirmed(result.txHash);

    return result.txHash;
  }

  /**
   * Unwrap WETH to ETH
   */
  async unwrapWeth(amount: Decimal): Promise<string> {
    const amountRaw = BigInt(amount.mul(new Decimal(10).pow(18)).floor().toString());

    const data = this.wethContract.interface.encodeFunctionData('withdraw', [amountRaw]);

    const result = await this.txPolicyService.sendTx({
      to: this.configService.pool.token0Address,
      data,
      description: `Unwrap ${amount.toFixed(6)} WETH → ETH`,
    });

    return result.txHash;
  }

  // ==================== Utility Methods ====================

  /**
   * Get wallet address
   */
  getAddress(): string {
    return this.wallet.address;
  }

  /**
   * Get token info
   */
  getTokenInfo(token: string): TokenInfo {
    const cached = this.tokenInfoCache.get(token.toLowerCase());
    if (cached) return cached;

    // Default to 18 decimals if unknown
    return {
      address: token,
      symbol: 'UNKNOWN',
      decimals: 18,
    };
  }

  /**
   * Check if wallet has sufficient ETH for gas
   */
  async hasSufficientGas(estimatedGas: Decimal): Promise<boolean> {
    const balances = await this.getBalances();
    return balances.ethForGas.greaterThanOrEqualTo(estimatedGas.add(this.config.minEthForGas));
  }

  // ==================== Configuration ====================

  getConfig(): WalletServiceConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<WalletServiceConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Wallet config updated', config);
  }
}
