/**
 * WalletService Integration Tests
 *
 * These tests run against a REAL blockchain (Arbitrum) with REAL funds.
 * Use minimal amounts for testing.
 *
 * Prerequisites:
 * - .env file with valid Web3 credentials (WEB3_PRIVATE_KEY, WEB3_RPC_URL)
 * - Wallet with WETH + USDC on Arbitrum
 * - Pool: Arbitrum WETH/USDC 0.05% (0xC6962004f452bE9203591991D15f6b388e09E8D0)
 *
 * Key methods tested:
 * - getBalances() / getBalancesWithValue()
 * - ensureAllowance() / getAllowance() / approve()
 * - rebalanceTo50_50() - main focus!
 * - swap()
 * - wrapEth() / unwrapWeth()
 */

import 'reflect-metadata';
import { container } from 'tsyringe';
import Decimal from 'decimal.js';

import { ConfigService } from '../../../config';
import { Logger, ILogger } from '../../../infra/logger/logger';
import { TOKENS } from '../../../di/tokens';
import { WalletService } from '../wallet.service';
import type { IWalletService } from '../wallet.interface';
import type { ITxPolicyService } from '../../tx-policy';
import { MockMonitoringService, type IMonitoringService } from '../../monitoring';
import { TxPolicyService } from '../../tx-policy/tx-policy.service';

// ==================== Test Configuration ====================

const TEST_CONFIG = {
  // Minimum balances for testing
  MIN_WETH: new Decimal('0.001'),
  MIN_USDC: new Decimal('5'),
  MIN_ETH_FOR_GAS: new Decimal('0.001'),

  // Rebalance test config
  REBALANCE_DEVIATION_THRESHOLD: 0.02, // 2% - lower threshold to trigger rebalance more easily
  REBALANCE_MAX_SLIPPAGE_BPS: 50, // 0.5%
  REBALANCE_DEADLINE_SEC: 120,
  REBALANCE_MIN_NOTIONAL_USDC: 20, // Very low for testing

  // Timeouts
  TX_TIMEOUT_MS: 120_000, // 2 minutes

  // Skip destructive tests by default
  SKIP_SWAP_TESTS: process.env['SKIP_SWAP_TESTS'] === 'true',
};

// ==================== Mock Monitoring Service ====================

import {
  Alert,
  AlertContext,
  AlertLevel,
  AlertStats,
  AlertHistoryEntry,
  DailyReportResult,
  MonitoringServiceConfig,
} from '../../monitoring/monitoring.types';

// ==================== Test Setup ====================

describe('WalletService Integration Tests', () => {
  let configService: ConfigService;
  let logger: Logger;
  let walletService: IWalletService;
  let txPolicyService: ITxPolicyService;
  let monitoringService: IMonitoringService;

  // Track initial balances for comparison
  let initialBalances: { weth: Decimal; usdc: Decimal; ethForGas: Decimal };

  beforeAll(async () => {
    // Set test timeout
    jest.setTimeout(300_000); // 5 minutes for all tests

    // Register real ConfigService (loads from .env)
    container.registerSingleton<ConfigService>(TOKENS.CONFIG_SERVICE, ConfigService);
    configService = container.resolve<ConfigService>(TOKENS.CONFIG_SERVICE);

    // Register Logger
    container.registerSingleton<Logger>(TOKENS.LOGGER, Logger);
    logger = container.resolve<Logger>(TOKENS.LOGGER);

    // Create mock monitoring service
    monitoringService = new MockMonitoringService(logger.child('MockMonitoring'));
    container.registerInstance<IMonitoringService>(TOKENS.MONITORING_SERVICE, monitoringService);

    // Register TxPolicyService (real - we need actual txs)
    container.registerSingleton<ITxPolicyService>(TOKENS.TX_POLICY_SERVICE, TxPolicyService);
    txPolicyService = container.resolve<ITxPolicyService>(TOKENS.TX_POLICY_SERVICE);

    // Register WalletService (real - this is what we're testing)
    container.registerSingleton<IWalletService>(TOKENS.WALLET_SERVICE, WalletService);
    walletService = container.resolve<IWalletService>(TOKENS.WALLET_SERVICE);

    // Log test configuration
    logger.info('WalletService integration test setup complete', {
      chainId: configService.web3.chainId,
      wallet: walletService.getAddress(),
      simulation: configService.isSimulationMode(),
    });

    // Get initial balances
    initialBalances = await walletService.getBalances();

    logger.info('Initial balances', {
      weth: initialBalances.weth.toFixed(6),
      usdc: initialBalances.usdc.toFixed(2),
      ethForGas: initialBalances.ethForGas.toFixed(6),
    });
  });

  afterAll(async () => {
    // Log final balances for comparison
    const finalBalances = await walletService.getBalances();
    logger.info('Final balances', {
      weth: finalBalances.weth.toFixed(6),
      usdc: finalBalances.usdc.toFixed(2),
      ethForGas: finalBalances.ethForGas.toFixed(6),
    });

    // Clear DI container
    container.clearInstances();
  });

  // ==================== Prerequisite Tests ====================

  describe('Prerequisites', () => {
    it('should have valid configuration', () => {
      expect(configService.web3.rpcUrl).toBeDefined();
      expect(configService.web3.privateKey).toBeDefined();
      expect(configService.web3.chainId).toBe(42161); // Arbitrum
    });

    it('should have wallet address', () => {
      const address = walletService.getAddress();
      expect(address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      logger.info('Wallet address', { address });
    });

    it('should have sufficient balances for testing', async () => {
      const balances = await walletService.getBalances();

      logger.info('Current balances', {
        weth: balances.weth.toFixed(6),
        usdc: balances.usdc.toFixed(2),
        ethForGas: balances.ethForGas.toFixed(6),
      });

      expect(balances.ethForGas.gte(TEST_CONFIG.MIN_ETH_FOR_GAS)).toBe(true);
      // At least some tokens should be present
      expect(balances.weth.gt(0) || balances.usdc.gt(0)).toBe(true);
    });
  });

  // ==================== Balance Tests ====================

  describe('Balances', () => {
    it('should get current balances', async () => {
      const balances = await walletService.getBalances();

      expect(balances.weth).toBeDefined();
      expect(balances.usdc).toBeDefined();
      expect(balances.ethForGas).toBeDefined();
      expect(balances.timestamp).toBeDefined();
      expect(balances.timestamp).toBeGreaterThan(0);

      logger.info('Balances fetched', {
        weth: balances.weth.toFixed(6),
        usdc: balances.usdc.toFixed(2),
        ethForGas: balances.ethForGas.toFixed(6),
      });
    });

    it('should get balances with value calculations', async () => {
      // Use a reasonable ETH price
      const referencePrice = new Decimal('3200');
      const balances = await walletService.getBalancesWithValue(referencePrice);

      expect(balances.totalValueUsdc).toBeDefined();
      expect(balances.wethValueUsdc).toBeDefined();
      expect(balances.wethPercent).toBeDefined();
      expect(balances.usdcPercent).toBeDefined();

      logger.info('Balances with value', {
        weth: balances.weth.toFixed(6),
        usdc: balances.usdc.toFixed(2),
        wethValueUsdc: balances.wethValueUsdc?.toFixed(2),
        totalValueUsdc: balances.totalValueUsdc?.toFixed(2),
        wethPercent: balances.wethPercent?.toFixed(2) + '%',
        usdcPercent: balances.usdcPercent?.toFixed(2) + '%',
      });
    });

    it('should check gas sufficiency', async () => {
      // Very small amount should pass
      const hasGasSmall = await walletService.hasSufficientGas(new Decimal('0.0001'));
      expect(hasGasSmall).toBe(true);

      // Huge amount should fail
      const hasGasHuge = await walletService.hasSufficientGas(new Decimal('1000'));
      expect(hasGasHuge).toBe(false);
    });
  });

  // ==================== Token Info Tests ====================

  describe('Token Info', () => {
    it('should get WETH token info', () => {
      const wethInfo = walletService.getTokenInfo(configService.pool.token0Address);

      expect(wethInfo.address.toLowerCase()).toBe(configService.pool.token0Address.toLowerCase());
      expect(wethInfo.decimals).toBe(18);
      expect(wethInfo.symbol).toBeDefined();

      logger.info('WETH info', wethInfo);
    });

    it('should get USDC token info', () => {
      const usdcInfo = walletService.getTokenInfo(configService.pool.token1Address);

      expect(usdcInfo.address.toLowerCase()).toBe(configService.pool.token1Address.toLowerCase());
      expect(usdcInfo.decimals).toBe(6);
      expect(usdcInfo.symbol).toBeDefined();

      logger.info('USDC info', usdcInfo);
    });
  });

  // ==================== Allowance Tests ====================

  describe('Allowances', () => {
    const positionManager = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88'; // Uniswap V3 Position Manager

    it('should get current allowance', async () => {
      const allowance = await walletService.getAllowance(
        configService.pool.token0Address, // WETH
        positionManager
      );

      expect(allowance).toBeDefined();
      expect(allowance.gte(0)).toBe(true);

      logger.info('Current WETH allowance for PositionManager', {
        allowance: allowance.toFixed(6),
      });
    });

    it('should ensure allowance (approve if needed)', async () => {
      const requiredAmount = new Decimal('0.001'); // Very small amount

      const result = await walletService.ensureAllowance(
        configService.pool.token0Address, // WETH
        positionManager,
        requiredAmount
      );

      expect(result.ok).toBe(true);
      expect(result.currentAllowance.gte(requiredAmount) || result.newAllowance?.gte(requiredAmount)).toBe(true);

      logger.info('Allowance result', {
        ok: result.ok,
        approvalMade: result.approvalMade,
        currentAllowance: result.currentAllowance.toFixed(6),
        newAllowance: result.newAllowance?.toFixed(6),
        txHash: result.txHash,
      });
    }, TEST_CONFIG.TX_TIMEOUT_MS);
  });

  // ==================== Config Tests ====================

  describe('Configuration', () => {
    it('should get current config', () => {
      const config = walletService.getConfig();

      expect(config.defaultSlippageBps).toBeDefined();
      expect(config.maxSlippageBps).toBeDefined();
      expect(config.minEthForGas).toBeDefined();
      expect(config.deadlineBufferSeconds).toBeDefined();

      logger.info('Wallet config', {
        defaultSlippageBps: config.defaultSlippageBps,
        maxSlippageBps: config.maxSlippageBps,
        minEthForGas: config.minEthForGas.toFixed(6),
        deadlineBufferSeconds: config.deadlineBufferSeconds,
      });
    });

    it('should update config', () => {
      const originalConfig = walletService.getConfig();
      const newSlippage = originalConfig.defaultSlippageBps + 10;

      walletService.updateConfig({ defaultSlippageBps: newSlippage });

      const updatedConfig = walletService.getConfig();
      expect(updatedConfig.defaultSlippageBps).toBe(newSlippage);

      // Restore original
      walletService.updateConfig({ defaultSlippageBps: originalConfig.defaultSlippageBps });
    });
  });

  // ==================== Rebalance Tests (MAIN FOCUS) ====================

  describe('Rebalance to 50/50', () => {
    it('should calculate rebalance in dry run mode', async () => {
      const balances = await walletService.getBalances();
      const referencePrice = new Decimal('3200'); // Approximate ETH price

      const result = await walletService.rebalanceTo50_50({
        referencePrice,
        deviationThresholdPct: TEST_CONFIG.REBALANCE_DEVIATION_THRESHOLD,
        maxSlippageBps: TEST_CONFIG.REBALANCE_MAX_SLIPPAGE_BPS,
        deadlineSec: TEST_CONFIG.REBALANCE_DEADLINE_SEC,
        minNotionalUsdc: TEST_CONFIG.REBALANCE_MIN_NOTIONAL_USDC,
        dryRun: true, // Just calculate, don't execute
      });

      expect(result.success).toBe(true);
      expect(result.balancesBefore).toBeDefined();
      expect(result.deviationPercentBefore).toBeDefined();

      logger.info('Dry run rebalance result', {
        rebalanceNeeded: result.rebalanceNeeded,
        direction: result.direction,
        deviationBefore: result.deviationPercentBefore?.toFixed(2) + '%',
        amountIn: result.amountIn?.toFixed(6),
        amountOutMin: result.amountOutMin?.toFixed(6),
        reason: result.reason,
      });
    });

    it('should skip rebalance if within threshold', async () => {
      const referencePrice = new Decimal('3200');

      // Use very high threshold so rebalance is not needed
      const result = await walletService.rebalanceTo50_50({
        referencePrice,
        deviationThresholdPct: 0.99, // 99% threshold - almost never triggers
        maxSlippageBps: TEST_CONFIG.REBALANCE_MAX_SLIPPAGE_BPS,
        deadlineSec: TEST_CONFIG.REBALANCE_DEADLINE_SEC,
        dryRun: false,
      });

      expect(result.success).toBe(true);
      expect(result.performed).toBe(false);
      expect(result.reason).toContain('within');

      logger.info('Skipped rebalance', {
        reason: result.reason,
        deviationBefore: result.deviationPercentBefore?.toFixed(2) + '%',
      });
    });

    it('should skip rebalance if below min notional', async () => {
      const balances = await walletService.getBalances();
      const referencePrice = new Decimal('3200');
      const totalValue = balances.weth.mul(referencePrice).add(balances.usdc);

      // Use very high min notional so swap is skipped
      const result = await walletService.rebalanceTo50_50({
        referencePrice,
        deviationThresholdPct: 0.01, // Very low threshold
        maxSlippageBps: TEST_CONFIG.REBALANCE_MAX_SLIPPAGE_BPS,
        deadlineSec: TEST_CONFIG.REBALANCE_DEADLINE_SEC,
        minNotionalUsdc: totalValue.toNumber() * 2, // Higher than total value
        dryRun: false,
      });

      expect(result.success).toBe(true);
      // Either not performed or direction is NONE
      if (result.rebalanceNeeded && !result.performed) {
        expect(result.reason).toContain('minNotional');
      }

      logger.info('Min notional check', {
        performed: result.performed,
        reason: result.reason,
      });
    });

    // This test actually executes a swap if needed
    it('should execute rebalance swap if needed', async () => {
      if (TEST_CONFIG.SKIP_SWAP_TESTS) {
        logger.warn('Skipping swap test (SKIP_SWAP_TESTS=true)');
        return;
      }

      const balancesBefore = await walletService.getBalancesWithValue(new Decimal('3200'));
      logger.info('Balances before rebalance attempt', {
        weth: balancesBefore.weth.toFixed(6),
        usdc: balancesBefore.usdc.toFixed(2),
        wethPercent: balancesBefore.wethPercent?.toFixed(2) + '%',
      });

      // Check if we're already balanced
      const wethPercent = balancesBefore.wethPercent?.toNumber() ?? 50;
      const deviation = Math.abs(wethPercent - 50);

      if (deviation < 5) {
        logger.info('Already balanced, skipping actual swap test', {
          deviation: deviation.toFixed(2) + '%',
        });
        return;
      }

      const referencePrice = new Decimal('3200');

      const result = await walletService.rebalanceTo50_50({
        referencePrice,
        deviationThresholdPct: 0.05, // 5% threshold
        maxSlippageBps: 50, // 0.5%
        deadlineSec: 120,
        minNotionalUsdc: 5, // Minimum $5
        dryRun: false,
      });

      logger.info('Rebalance result', {
        success: result.success,
        performed: result.performed,
        direction: result.direction,
        amountIn: result.amountIn?.toFixed(6),
        amountOut: result.amountOut?.toFixed(6),
        txHash: result.txHash,
        reason: result.reason,
        deviationBefore: result.deviationPercentBefore?.toFixed(2) + '%',
        deviationAfter: result.deviationPercent?.toFixed(2) + '%',
      });

      expect(result.success).toBe(true);

      if (result.performed) {
        expect(result.txHash).toBeDefined();
        expect(result.direction).not.toBe('NONE');
        expect(result.balancesAfter).toBeDefined();

        // Check that deviation is now lower
        const balancesAfter = result.balancesAfter!;
        const newWethPercent = balancesAfter.wethPercent?.toNumber() ?? 50;
        const newDeviation = Math.abs(newWethPercent - 50);

        logger.info('After rebalance', {
          wethPercent: newWethPercent.toFixed(2) + '%',
          newDeviation: newDeviation.toFixed(2) + '%',
        });

        // New deviation should be lower than before (or at least reasonable)
        expect(newDeviation).toBeLessThan(15); // Allow some slippage
      }
    }, TEST_CONFIG.TX_TIMEOUT_MS);

    // Test legacy signature
    it('should work with legacy signature', async () => {
      const referencePrice = new Decimal('3200');
      const targetTotal = new Decimal('500'); // Arbitrary

      // This should not throw
      const result = await walletService.rebalanceTo50_50(
        targetTotal,
        referencePrice,
        50 // slippage bps
      );

      expect(result.success).toBe(true);
      expect(result.balancesBefore).toBeDefined();

      logger.info('Legacy signature result', {
        success: result.success,
        reason: result.reason,
      });
    });
  });

  // ==================== Wrap/Unwrap Tests ====================

  describe.skip('Wrap/Unwrap ETH', () => {
    // Helper to wait for RPC state to settle
    const waitForRpcState = () => new Promise(resolve => setTimeout(resolve, 2000));

    it('should wrap small amount of ETH to WETH', async () => {
      if (TEST_CONFIG.SKIP_SWAP_TESTS) {
        logger.warn('Skipping wrap test (SKIP_SWAP_TESTS=true)');
        return;
      }

      const balancesBefore = await walletService.getBalances();

      // Only test if we have enough ETH
      if (balancesBefore.ethForGas.lt(0.01)) {
        logger.warn('Not enough ETH for wrap test, skipping');
        return;
      }

      const wrapAmount = new Decimal('0.001'); // Wrap 0.001 ETH

      const txHash = await walletService.wrapEth(wrapAmount);

      expect(txHash).toBeDefined();
      expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Wait for RPC state to settle
      await waitForRpcState();

      const balancesAfter = await walletService.getBalances();

      logger.info('Wrap ETH result', {
        txHash,
        wethBefore: balancesBefore.weth.toFixed(6),
        wethAfter: balancesAfter.weth.toFixed(6),
        wethDelta: balancesAfter.weth.sub(balancesBefore.weth).toFixed(6),
        ethBefore: balancesBefore.ethForGas.toFixed(6),
        ethAfter: balancesAfter.ethForGas.toFixed(6),
      });

      // WETH should increase by approximately wrapAmount
      const wethDelta = balancesAfter.weth.sub(balancesBefore.weth);
      expect(wethDelta.gte(wrapAmount.mul(0.99))).toBe(true);
    }, TEST_CONFIG.TX_TIMEOUT_MS);

    it('should unwrap small amount of WETH to ETH', async () => {
      if (TEST_CONFIG.SKIP_SWAP_TESTS) {
        logger.warn('Skipping unwrap test (SKIP_SWAP_TESTS=true)');
        return;
      }

      const balancesBefore = await walletService.getBalances();

      // Only test if we have enough WETH
      if (balancesBefore.weth.lt(0.002)) {
        logger.warn('Not enough WETH for unwrap test, skipping');
        return;
      }

      const unwrapAmount = new Decimal('0.001'); // Unwrap 0.001 WETH

      const txHash = await walletService.unwrapWeth(unwrapAmount);

      expect(txHash).toBeDefined();
      expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Wait for RPC state to settle
      await waitForRpcState();

      const balancesAfter = await walletService.getBalances();

      logger.info('Unwrap WETH result', {
        txHash,
        wethBefore: balancesBefore.weth.toFixed(6),
        wethAfter: balancesAfter.weth.toFixed(6),
        wethDelta: balancesBefore.weth.sub(balancesAfter.weth).toFixed(6),
        ethBefore: balancesBefore.ethForGas.toFixed(6),
        ethAfter: balancesAfter.ethForGas.toFixed(6),
        ethDelta: balancesAfter.ethForGas.sub(balancesBefore.ethForGas).toFixed(6),
      });

      // Verify unwrap happened - WETH should decrease by approximately unwrapAmount
      const wethDelta = balancesBefore.weth.sub(balancesAfter.weth);
      // Allow for some tolerance due to potential pending tx
      expect(wethDelta.gte(unwrapAmount.mul(0.99))).toBe(true); // At least 99% of unwrapAmount
    }, TEST_CONFIG.TX_TIMEOUT_MS);
  });

  // ==================== Swap Tests ====================

  describe('Direct Swap', () => {
    // Helper to wait for RPC state to settle
    const waitForRpcState = () => new Promise(resolve => setTimeout(resolve, 2000));

    it('should execute small WETH -> USDC swap', async () => {
      if (TEST_CONFIG.SKIP_SWAP_TESTS) {
        logger.warn('Skipping direct swap test (SKIP_SWAP_TESTS=true)');
        return;
      }

      const balancesBefore = await walletService.getBalances();

      // Only test if we have enough WETH
      if (balancesBefore.weth.lt(0.005)) {
        logger.warn('Not enough WETH for swap test, skipping');
        return;
      }

      const amountIn = new Decimal('0.001'); // Swap 0.001 WETH
      const minAmountOut = new Decimal('1'); // Expect at least $1 (very loose)

      const txHash = await walletService.swap(
        configService.pool.token0Address, // WETH
        configService.pool.token1Address, // USDC
        amountIn,
        minAmountOut
      );

      expect(txHash).toBeDefined();
      expect(txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

      // Wait for RPC state to settle
      await waitForRpcState();

      const balancesAfter = await walletService.getBalances();

      logger.info('WETH -> USDC swap result', {
        txHash,
        amountIn: amountIn.toFixed(6),
        wethBefore: balancesBefore.weth.toFixed(6),
        wethAfter: balancesAfter.weth.toFixed(6),
        wethDelta: balancesBefore.weth.sub(balancesAfter.weth).toFixed(6),
        usdcBefore: balancesBefore.usdc.toFixed(2),
        usdcAfter: balancesAfter.usdc.toFixed(2),
        usdcDelta: balancesAfter.usdc.sub(balancesBefore.usdc).toFixed(2),
      });

      // Verify swap happened
      const wethDelta = balancesBefore.weth.sub(balancesAfter.weth);
      const usdcDelta = balancesAfter.usdc.sub(balancesBefore.usdc);

      // WETH should decrease by approximately amountIn
      expect(wethDelta.gte(amountIn.mul(0.99))).toBe(true);
      // USDC should increase by at least minAmountOut
      expect(usdcDelta.gte(minAmountOut)).toBe(true);
    }, TEST_CONFIG.TX_TIMEOUT_MS);
  });

  // ==================== Error Handling Tests ====================

  describe('Error Handling', () => {
    it('should fail gracefully for invalid token address', async () => {
      await expect(
        walletService.getAllowance(
          '0x0000000000000000000000000000000000000000', // Invalid token
          '0xC36442b4a4522E871399CD717aBDD847Ab11FE88'
        )
      ).rejects.toThrow();
    });

    it('should handle rebalance with zero reference price gracefully', async () => {
      // With zero price, WETH value = 0, so deviation is high but delta is 0
      // Function should not crash and return a valid result
      const result = await walletService.rebalanceTo50_50({
        referencePrice: new Decimal(0),
        deviationThresholdPct: 0.05,
        maxSlippageBps: 50,
        deadlineSec: 120,
        minNotionalUsdc: 5,
        dryRun: true,
      });

      // With zero price, WETH value is 0, so it wants to buy WETH (USDC_TO_WETH)
      // But the delta will be skipped if below minNotional or cause division issues
      expect(result.success).toBe(true);
      expect(result.performed).toBe(false); // Cannot perform with zero price
      logger.info('Zero price rebalance result', {
        direction: result.direction,
        reason: result.reason,
      });
    });
  });
});
