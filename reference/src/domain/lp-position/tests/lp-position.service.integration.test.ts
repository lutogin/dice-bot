/**
 * LpPositionService Integration Tests
 *
 * These tests run against a REAL blockchain (Arbitrum) with REAL funds.
 * Use minimal amounts (~$50 or less) for testing.
 *
 * Prerequisites:
 * - .env file with valid Web3 credentials (WEB3_PRIVATE_KEY, WEB3_RPC_URL)
 * - Wallet with WETH + USDC on Arbitrum (at least $100 for safety)
 * - Pool: Arbitrum WETH/USDC 0.05% (0xC6962004f452bE9203591991D15f6b388e09E8D0)
 *
 * Test Flow (mirrors ExecutionOrchestrator reset-range):
 * 1. Get pool state → check current price
 * 2. Calculate symmetric range ±5%
 * 3. Check wallet balances
 * 4. Mint new LP position (minimal amounts)
 * 5. Get composition of new position
 * 6. Decrease liquidity 100%
 * 7. Collect fees/tokens
 * 8. Verify tokens returned to wallet
 * 9. Burn empty NFT (optional)
 */

import 'reflect-metadata';
import { container } from 'tsyringe';
import Decimal from 'decimal.js';

import { ConfigService } from '../../../config';
import { Logger, ILogger } from '../../../infra/logger/logger';
import { TOKENS } from '../../../di/tokens';
import { LpPositionService } from '../lp-position.service';
import type { ILpPositionService } from '../lp-position.interface';
import type { IWalletService } from '../../wallet';
import type { ITxPolicyService } from '../../tx-policy';
import { MockMonitoringService, type IMonitoringService } from '../../monitoring';
import { WalletService } from '../../wallet/wallet.service';
import { TxPolicyService } from '../../tx-policy/tx-policy.service';

// ==================== Test Configuration ====================

const TEST_CONFIG = {
  // Minimum amounts for testing (in human-readable units)
  MIN_WETH: new Decimal('0.005'),   // ~$15 at $3000/ETH
  MIN_USDC: new Decimal('15'),      // $15
  MIN_ETH_FOR_GAS: new Decimal('0.002'), // ~$6 for gas

  // Range width for test position
  RANGE_WIDTH_PERCENT: 5, // ±5%

  // Timeouts
  TX_TIMEOUT_MS: 120_000, // 2 minutes for tx confirmation

  // Skip destructive tests by default
  SKIP_DESTRUCTIVE: process.env['SKIP_DESTRUCTIVE_TESTS'] === 'true',
};


// ==================== Test Setup ====================

describe('LpPositionService Integration Tests', () => {
  let configService: ConfigService;
  let logger: Logger;
  let lpService: ILpPositionService;
  let walletService: IWalletService;
  let txPolicyService: ITxPolicyService;
  let monitoringService: IMonitoringService;

  // Track minted token IDs for cleanup
  // Use env var LP_EXISTING_TOKEN_ID for testing on existing position
  const existingTokenId = process.env['LP_EXISTING_TOKEN_ID'];
  const mintedTokenIds: string[] = existingTokenId ? [existingTokenId] : [];

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

    // Register WalletService (real - we need actual balances and swaps)
    container.registerSingleton<IWalletService>(TOKENS.WALLET_SERVICE, WalletService);
    walletService = container.resolve<IWalletService>(TOKENS.WALLET_SERVICE);

    // Register LpPositionService (real - this is what we're testing)
    container.registerSingleton<ILpPositionService>(TOKENS.LP_POSITION_SERVICE, LpPositionService);
    lpService = container.resolve<ILpPositionService>(TOKENS.LP_POSITION_SERVICE);

    // Log test configuration
    logger.info('Integration test setup complete', {
      chainId: configService.web3.chainId,
      pool: configService.pool.poolAddress,
      wallet: walletService.getAddress(),
      simulation: configService.isSimulationMode(),
    });
  });

  afterAll(async () => {
    // Cleanup: burn any minted test positions
    // NOTE: Before burning, we MUST collect() to clear any uncollected tokens/fees
    // Uniswap V3 requires position to be fully "cleared" before burn
    for (const tokenId of mintedTokenIds) {
      try {
        logger.info(`Cleaning up test position: ${tokenId}`);
        lpService.setTokenId(tokenId);

        // Check position state
        const position = await lpService.getPositionById(tokenId);
        logger.info(`Position state for cleanup`, {
          tokenId,
          liquidity: position.liquidity.toFixed(0),
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
        });

        // If position has liquidity, decrease it first
        if (!position.liquidity.isZero()) {
          logger.info(`Decreasing liquidity to 0% for position ${tokenId}`);
          await lpService.decreaseLiquidity({ percent: 100, slippageBps: 100 });
        }

        // ALWAYS collect before burn to clear tokens owed
        // This is required by Uniswap V3 - burn reverts with "Not cleared" otherwise
        logger.info(`Collecting tokens/fees for position ${tokenId}`);
        const collectResult = await lpService.collectFees();
        logger.info(`Collected for position ${tokenId}`, {
          amount0: collectResult.amount0.toFixed(6),
          amount1: collectResult.amount1.toFixed(6),
          txHash: collectResult.txHash,
        });

        // Now burn the empty NFT
        logger.info(`Burning position ${tokenId}`);
        await lpService.burnPosition(tokenId);
        logger.info(`Burned test position: ${tokenId}`);
      } catch (error) {
        logger.warn(`Failed to cleanup position ${tokenId}`, { error });
      }
    }

    // Clear DI container
    container.clearInstances();
  }, TEST_CONFIG.TX_TIMEOUT_MS * 2); // 4 minutes timeout for cleanup

  // ==================== Prerequisite Tests ====================

  describe('Prerequisites', () => {
    it('should have valid configuration', () => {
      expect(configService.web3.rpcUrl).toBeDefined();
      expect(configService.web3.privateKey).toBeDefined();
      expect(configService.web3.chainId).toBe(42161); // Arbitrum
      expect(configService.pool.poolAddress).toBeDefined();
    });

    it('should connect to wallet', () => {
      const address = lpService.getWalletAddress();
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

      expect(balances.weth.gte(TEST_CONFIG.MIN_WETH)).toBe(true);
      expect(balances.usdc.gte(TEST_CONFIG.MIN_USDC)).toBe(true);
      expect(balances.ethForGas.gte(TEST_CONFIG.MIN_ETH_FOR_GAS)).toBe(true);
    });
  });

  // ==================== Pool State Tests ====================

  describe('Pool State', () => {
    it('should fetch current pool state', async () => {
      const poolState = await lpService.getPoolState();

      expect(poolState.poolAddress).toBe(configService.pool.poolAddress);
      expect(poolState.tick).toBeDefined();
      expect(poolState.spotPrice.gt(0)).toBe(true);
      expect(poolState.fee).toBe(configService.pool.feeTier);

      logger.info('Pool state', {
        tick: poolState.tick,
        spotPrice: poolState.spotPrice.toFixed(2),
        fee: poolState.fee,
      });
    });

    it('should convert price to tick and back', async () => {
      const poolState = await lpService.getPoolState();
      const spotPrice = poolState.spotPrice;

      // Price → Tick → Price should be close
      const tick = lpService.priceToTick(spotPrice);
      const priceBack = lpService.tickToPrice(tick);

      // Allow 0.5% deviation due to tick spacing
      const deviation = priceBack.sub(spotPrice).abs().div(spotPrice);
      expect(deviation.lt(0.005)).toBe(true);

      logger.info('Price/Tick conversion', {
        spotPrice: spotPrice.toFixed(2),
        tick,
        priceBack: priceBack.toFixed(2),
        deviation: deviation.mul(100).toFixed(4) + '%',
      });
    });

    it('should calculate symmetric range around current price', async () => {
      const { tickLower, tickUpper } = await lpService.calculateSymmetricRange(
        TEST_CONFIG.RANGE_WIDTH_PERCENT
      );

      // Ticks should be valid
      expect(tickLower).toBeLessThan(tickUpper);

      // Convert to prices
      const priceLower = lpService.tickToPrice(tickLower);
      const priceUpper = lpService.tickToPrice(tickUpper);
      const poolState = await lpService.getPoolState();

      // Current price should be within range
      expect(poolState.spotPrice.gte(priceLower)).toBe(true);
      expect(poolState.spotPrice.lte(priceUpper)).toBe(true);

      // Range width should be approximately correct
      const actualWidth = priceUpper.sub(priceLower).div(poolState.spotPrice).mul(100);
      expect(actualWidth.gte(TEST_CONFIG.RANGE_WIDTH_PERCENT * 1.5)).toBe(true);
      expect(actualWidth.lte(TEST_CONFIG.RANGE_WIDTH_PERCENT * 2.5)).toBe(true);

      logger.info('Symmetric range calculated', {
        tickLower,
        tickUpper,
        priceLower: priceLower.toFixed(2),
        priceUpper: priceUpper.toFixed(2),
        rangeWidth: actualWidth.toFixed(2) + '%',
      });
    });
  });

  // ==================== Full LP Lifecycle Test ====================

  describe('LP Lifecycle (Mint → Composition → Decrease → Collect)', () => {
    let testTokenId: string | null = mintedTokenIds[0] || null;
    let initialBalances: { weth: Decimal; usdc: Decimal; ethForGas: Decimal };

    beforeAll(async () => {
      // Capture initial balances
      initialBalances = await walletService.getBalances();
    });

    it('should mint new LP position using mintNewPositionForBudget', async () => {
      if (configService.isSimulationMode()) {
        logger.warn('Simulation mode: skipping actual mint');
        return;
      }

      // Step 1: Calculate range
      const { tickLower, tickUpper } = await lpService.calculateSymmetricRange(
        TEST_CONFIG.RANGE_WIDTH_PERCENT
      );

      // Step 2: Get pool state for reference price
      const poolState = await lpService.getPoolState();
      const referencePrice = poolState.spotPrice;

      logger.info('Minting test position', {
        tickLower,
        tickUpper,
        referencePrice: referencePrice.toFixed(2),
      });

      // Step 3: Mint using budget method
      // Note: amount0MinPct/amount1MinPct are set low because Uniswap V3 decides
      // the actual ratio based on current tick position within the range.
      // If tick is near edge, one amount might be close to 0.
      const mintResult = await lpService.mintNewPositionForBudget({
        tickLower,
        tickUpper,
        referencePrice,
        budgetPolicy: {
          useAllBalances: false,
          amountSafetyPct: new Decimal('0.5'), // Only use 50% of balance for safety
          reserveEthForGas: new Decimal('0.005'),
          amount0MinPct: new Decimal('0.01'), // Very lenient - pool decides ratio
          amount1MinPct: new Decimal('0.01'), // Very lenient - pool decides ratio
          deadlineSec: 300,
          maxLeftoverPctWarn: new Decimal('0.8'), // Allow high leftover since ratio varies
        },
      });

      expect(mintResult.success).toBe(true);
      expect(mintResult.newTokenId).toBeDefined();
      expect(mintResult.txHash).toBeDefined();

      testTokenId = mintResult.newTokenId!;
      mintedTokenIds.push(testTokenId);

      // Set as tracked token
      lpService.setTokenId(testTokenId);

      logger.info('Mint successful', {
        tokenId: testTokenId,
        txHash: mintResult.txHash,
        usedWeth: mintResult.usedWeth.toFixed(6),
        usedUsdc: mintResult.usedUsdc.toFixed(2),
        leftoverPct: mintResult.leftoverPct.mul(100).toFixed(2) + '%',
      });
    }, TEST_CONFIG.TX_TIMEOUT_MS);

    it('should get composition of minted position', async () => {
      if (!testTokenId) {
        logger.warn('No test position, skipping composition test');
        return;
      }

      const poolState = await lpService.getPoolState();
      const composition = await lpService.getComposition(poolState.spotPrice);

      expect(composition.inRange).toBe(true);
      expect(composition.wethAmount.gte(0)).toBe(true);
      expect(composition.usdcAmount.gte(0)).toBe(true);
      expect(composition.totalValueUsdc.gt(0)).toBe(true);

      logger.info('Position composition', {
        weth: composition.wethAmount.toFixed(6),
        usdc: composition.usdcAmount.toFixed(2),
        totalValueUsdc: composition.totalValueUsdc.toFixed(2),
        inRange: composition.inRange,
        tickLower: composition.tickLower,
        tickUpper: composition.tickUpper,
        currentTick: composition.currentTick,
      });
    });

    it('should check position is in range', async () => {
      if (!testTokenId) {
        logger.warn('No test position, skipping inRange test');
        return;
      } else {
        lpService.setTokenId(testTokenId); // for testing on existing position
      }

      const inRange = await lpService.isInRange();
      expect(inRange).toBe(true);
    });

    it('should get distance to bounds', async () => {
      if (!testTokenId) {
        logger.warn('No test position, skipping bounds test');
        return;
      } else {
        lpService.setTokenId(testTokenId); // for testing on existing position
      }

      const distances = await lpService.getDistanceToBounds();

      expect(distances.toLower.gt(0)).toBe(true);
      expect(distances.toUpper.gt(0)).toBe(true);

      logger.info('Distance to bounds', {
        toLower: distances.toLower.toFixed(2) + '%',
        toUpper: distances.toUpper.toFixed(2) + '%',
      });
    });

    it('should decrease liquidity 100%', async () => {
      if (!testTokenId || configService.isSimulationMode()) {
        logger.warn('No test position or simulation mode, skipping decrease');
        return;
      } else {
        lpService.setTokenId(testTokenId); // for testing on existing position
      }

      const decreaseResult = await lpService.decreaseLiquidity({
        percent: 100,
        slippageBps: 100, // 1% slippage
      });

      expect(decreaseResult.success).toBe(true);
      expect(decreaseResult.txHash).toBeDefined();

      logger.info('Decrease liquidity result', {
        txHash: decreaseResult.txHash,
        success: decreaseResult.success,
      });
    }, TEST_CONFIG.TX_TIMEOUT_MS);

    it('should collect fees and tokens', async () => {
      if (!testTokenId || configService.isSimulationMode()) {
        logger.warn('No test position or simulation mode, skipping collect');
        return;
      }

      const collectResult = await lpService.collectFees();

      expect(collectResult.txHash).toBeDefined();
      // Amounts might be 0 if we just minted and decreased immediately
      expect(collectResult.amount0.gte(0)).toBe(true);
      expect(collectResult.amount1.gte(0)).toBe(true);

      logger.info('Collect fees result', {
        txHash: collectResult.txHash,
        amount0: collectResult.amount0.toFixed(6),
        amount1: collectResult.amount1.toFixed(2),
      });
    }, TEST_CONFIG.TX_TIMEOUT_MS);

    it('should verify tokens returned to wallet', async () => {
      if (!testTokenId || configService.isSimulationMode()) {
        logger.warn('No test position or simulation mode, skipping verification');
        return;
      }

      const finalBalances = await walletService.getBalances();

      logger.info('Balance comparison', {
        initial: {
          weth: initialBalances.weth.toFixed(6),
          usdc: initialBalances.usdc.toFixed(2),
        },
        final: {
          weth: finalBalances.weth.toFixed(6),
          usdc: finalBalances.usdc.toFixed(2),
        },
      });

      // Total value should be approximately the same (minus gas costs)
      const poolState = await lpService.getPoolState();
      const initialValue = initialBalances.weth.mul(poolState.spotPrice).add(initialBalances.usdc);
      const finalValue = finalBalances.weth.mul(poolState.spotPrice).add(finalBalances.usdc);

      // Allow up to 5% loss due to gas and slippage in tests
      const valueLoss = initialValue.sub(finalValue).div(initialValue);
      expect(valueLoss.lt(0.05)).toBe(true);

      logger.info('Value comparison', {
        initialValue: initialValue.toFixed(2),
        finalValue: finalValue.toFixed(2),
        loss: valueLoss.mul(100).toFixed(2) + '%',
      });
    });

    it('should burn empty position NFT', async () => {
      if (!testTokenId || configService.isSimulationMode() || TEST_CONFIG.SKIP_DESTRUCTIVE) {
        logger.warn('Skipping burn test');
        return;
      }

      // Verify position has zero liquidity
      const position = await lpService.getPositionById(testTokenId);
      expect(position.liquidity.isZero()).toBe(true);

      const burnResult = await lpService.burnPosition(testTokenId);
      expect(burnResult.success).toBe(true);

      logger.info('Position burned', {
        tokenId: testTokenId,
        txHash: burnResult.txHash,
      });

      // Remove from cleanup list since we burned it
      const idx = mintedTokenIds.indexOf(testTokenId);
      if (idx > -1) {
        mintedTokenIds.splice(idx, 1);
      }
    }, TEST_CONFIG.TX_TIMEOUT_MS);
  });

  // ==================== Existing Position Tests ====================

  describe('Existing Position (auto-discovered or manual)', () => {
    // Can be set manually for testing specific position: TEST_POSITION_ID=5223587 npm run test:lp
    // If not set, will auto-discover from wallet
    let testTokenId: string | null = process.env['TEST_POSITION_ID'] || null;

    beforeAll(async () => {
      // If no manual token ID, try to auto-discover active position
      if (!testTokenId) {
        const discovery = await lpService.discoverWalletPositions();
        if (discovery.bestActivePosition) {
          testTokenId = discovery.bestActivePosition.tokenId;
          logger.info('Auto-discovered active position for tests', { tokenId: testTokenId });
        } else if (discovery.matchingPoolPositions.length > 0) {
          // Use any matching position (even with 0 liquidity) for read-only tests
          testTokenId = discovery.matchingPoolPositions[0].tokenId;
          logger.info('Using matching pool position (may have 0 liquidity)', { tokenId: testTokenId });
        } else {
          logger.info('No existing positions found, skipping existing position tests');
        }
      }
    });

    it('should read existing position if available', async () => {
      if (!testTokenId) {
        logger.info('No test position available, skipping');
        return;
      }

      lpService.setTokenId(testTokenId);

      try {
        const position = await lpService.getPosition();

        expect(position.tokenId).toBe(testTokenId);
        expect(position.liquidity).toBeDefined();

        logger.info('Existing position', {
          tokenId: position.tokenId,
          liquidity: position.liquidity.toFixed(),
          hasLiquidity: position.liquidity.gt(0),
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
          priceLower: position.priceLower?.toFixed(2),
          priceUpper: position.priceUpper?.toFixed(2),
        });
      } catch (error) {
        // Position might have been burned or is invalid
        const errorMsg = (error as Error).message;
        if (errorMsg.includes('Invalid token ID') || errorMsg.includes('ERC721')) {
          logger.warn(`Position ${testTokenId} no longer exists (burned), skipping test`);
          return;
        }
        throw error;
      }
    });

    it('should get composition of existing position', async () => {
      if (!testTokenId) {
        return;
      }

      lpService.setTokenId(testTokenId);

      try {
        const poolState = await lpService.getPoolState();
        const composition = await lpService.getComposition(poolState.spotPrice);

        logger.info('Existing position composition', {
          tokenId: testTokenId,
          weth: composition.wethAmount.toFixed(6),
          usdc: composition.usdcAmount.toFixed(2),
          totalValueUsdc: composition.totalValueUsdc.toFixed(2),
          inRange: composition.inRange,
          distanceToLower: composition.distanceToLowerPercent.toFixed(2) + '%',
          distanceToUpper: composition.distanceToUpperPercent.toFixed(2) + '%',
        });
      } catch (error) {
        // Position might have been burned or is invalid
        const errorMsg = (error as Error).message;
        if (errorMsg.includes('Invalid token ID') || errorMsg.includes('ERC721')) {
          logger.warn(`Position ${testTokenId} no longer exists (burned), skipping test`);
          return;
        }
        throw error;
      }
    });
  });

  // ==================== Position Discovery Tests ====================

  describe('Position Discovery', () => {
    it('should discover all wallet LP positions', async () => {
      const result = await lpService.discoverWalletPositions();

      logger.info('Position discovery result', {
        totalNfts: result.totalNfts,
        allPositions: result.allPositions.length,
        matchingPool: result.matchingPoolPositions.length,
        activePositions: result.activePositions.length,
        bestTokenId: result.bestActivePosition?.tokenId,
      });

      // Log details of each position
      for (const pos of result.allPositions) {
        logger.debug('Position found', {
          tokenId: pos.tokenId,
          fee: pos.fee,
          liquidity: pos.liquidity.toFixed(0),
          matchesPool: pos.matchesConfigPool,
          hasLiquidity: pos.hasLiquidity,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
        });
      }

      expect(result.totalNfts).toBeGreaterThanOrEqual(0);
      expect(result.allPositions.length).toBe(result.totalNfts);
    });

    it('should get active position for configured pool', async () => {
      const activeTokenId = await lpService.getActivePositionForPool();

      logger.info('Active position for pool', {
        activeTokenId,
        hasActivePosition: activeTokenId !== null,
      });

      // This may or may not find an active position depending on test state
      if (activeTokenId) {
        // Validate the found position
        const isValid = await lpService.isValidPosition(activeTokenId);
        expect(isValid).toBe(true);
      }
    });

    it('should validate position correctly', async () => {
      // Test with non-existent token
      const isInvalidValid = await lpService.isValidPosition('999999999999');
      expect(isInvalidValid).toBe(false);

      // Test with existing token if we have one from discovery
      const discovery = await lpService.discoverWalletPositions();
      if (discovery.matchingPoolPositions.length > 0) {
        const validTokenId = discovery.matchingPoolPositions[0].tokenId;
        const isValid = await lpService.isValidPosition(validTokenId);
        expect(isValid).toBe(true);
      }
    });
  });

  // ==================== Error Handling Tests ====================

  describe('Error Handling', () => {
    it('should throw when no tokenId set', async () => {
      // Create a fresh instance without tokenId
      const freshLpService = new LpPositionService(
        logger,
        configService,
        walletService,
        txPolicyService,
        monitoringService
      );

      await expect(freshLpService.getPosition()).rejects.toThrow('No tokenId set');
    });

    it('should throw for invalid tokenId', async () => {
      lpService.setTokenId('999999999999'); // Non-existent token

      await expect(lpService.getPosition()).rejects.toThrow();
    });

    it('should reject invalid range for mintNewPositionForBudget', async () => {
      // Range that doesn't contain current price
      const poolState = await lpService.getPoolState();
      const currentTick = poolState.tick;

      // Both ticks below current (invalid)
      const result = await lpService.mintNewPositionForBudget({
        tickLower: currentTick - 2000,
        tickUpper: currentTick - 1000, // Both below current tick
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Range must contain current price');
    });
  });

  // ==================== Rebalance Integration Test ====================

  describe('Wallet Rebalance Integration', () => {
    it('should check current balance imbalance', async () => {
      const balances = await walletService.getBalances();
      const poolState = await lpService.getPoolState();

      const wethValueUsdc = balances.weth.mul(poolState.spotPrice);
      const totalValue = wethValueUsdc.add(balances.usdc);
      const wethPercent = wethValueUsdc.div(totalValue).mul(100);
      const usdcPercent = balances.usdc.div(totalValue).mul(100);

      logger.info('Current balance distribution', {
        wethPercent: wethPercent.toFixed(2) + '%',
        usdcPercent: usdcPercent.toFixed(2) + '%',
        imbalance: wethPercent.sub(50).abs().toFixed(2) + '%',
      });
    });
  });

  // ==================== Manual Cleanup Utility ====================
  // Run with: LP_CLEANUP_TOKEN_ID=<tokenId> npm run test:integration:lp -- --testNamePattern="Manual Cleanup"

  describe('Manual Cleanup (collect + burn)', () => {
    const cleanupTokenId = process.env['LP_CLEANUP_TOKEN_ID'];

    it('should collect fees and burn position', async () => {
      if (!cleanupTokenId) {
        logger.info('No LP_CLEANUP_TOKEN_ID set, skipping cleanup');
        logger.info('To run: LP_CLEANUP_TOKEN_ID=<tokenId> npm run test:integration:lp -- --testNamePattern="Manual Cleanup"');
        return;
      }

      logger.info('=== Manual Cleanup Started ===', { tokenId: cleanupTokenId });

      // Set the token ID
      lpService.setTokenId(cleanupTokenId);

      // Step 1: Get position state
      const position = await lpService.getPositionById(cleanupTokenId);
      logger.info('Position state', {
        tokenId: cleanupTokenId,
        liquidity: position.liquidity.toFixed(0),
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
      });

      // Step 2: Decrease liquidity if needed
      if (!position.liquidity.isZero()) {
        logger.info('Decreasing liquidity to 0%...');
        const decreaseResult = await lpService.decreaseLiquidity({ percent: 100, slippageBps: 100 });
        logger.info('Liquidity decreased', { txHash: decreaseResult.txHash });
      } else {
        logger.info('Liquidity already 0, skipping decrease');
      }

      // Step 3: Collect fees and tokens (REQUIRED before burn!)
      logger.info('Collecting fees and tokens...');
      const collectResult = await lpService.collectFees();
      logger.info('Collected', {
        txHash: collectResult.txHash,
        amount0_WETH: collectResult.amount0.toFixed(8),
        amount1_USDC: collectResult.amount1.toFixed(6),
      });

      // Step 4: Burn the empty NFT
      logger.info('Burning NFT...');
      const burnResult = await lpService.burnPosition(cleanupTokenId);
      logger.info('Burned', { txHash: burnResult.txHash, success: burnResult.success });

      expect(burnResult.success).toBe(true);

      // Step 5: Check final balances
      const balances = await walletService.getBalances();
      logger.info('=== Manual Cleanup Complete ===', {
        weth: balances.weth.toFixed(6),
        usdc: balances.usdc.toFixed(2),
        ethForGas: balances.ethForGas.toFixed(6),
      });
    }, TEST_CONFIG.TX_TIMEOUT_MS * 2);
  });
});
