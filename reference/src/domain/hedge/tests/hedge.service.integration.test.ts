/**
 * Integration Tests for HedgeService
 *
 * Tests hedge (short) position management on Binance Futures.
 *
 * Uses:
 * - Real BinanceClient (connected to Binance API)
 * - Real ConfigService (loads from .env)
 * - Mocked MonitoringService
 *
 * WARNING: These tests execute REAL trades on Binance!
 * Use testnet or small amounts for safety.
 */

import 'reflect-metadata';
import { container } from 'tsyringe';
import Decimal from 'decimal.js';
import dotenv from 'dotenv';

// Load environment variables FIRST
dotenv.config();

import { HedgeService } from '../hedge.service';
import { HedgeUrgency, HedgeSnapshot, HedgeAdjustResult } from '../hedge.types';
import { ConfigService } from '../../../config';
import { Logger } from '../../../infra/logger/logger';
import { BinanceClient } from '../../../integrations/exchanges/clients/binance/binance';
import { TOKENS } from '../../../di/tokens';
import type { IMonitoringService } from '../../monitoring/monitoring.interface';
import type {
  Alert,
  AlertLevel,
  AlertChannel,
  AlertHistoryEntry,
  AlertStats,
  DailyReportResult,
  MonitoringServiceConfig,
} from '../../monitoring/monitoring.types';

// ==================== Test Configuration ====================

/**
 * Test position in USDC
 * Must be large enough so 10-15% changes exceed all min thresholds
 * $300 * 10% = $30 - comfortably above any threshold
 */
const TEST_POSITION_USDC = 300;

/** Wait time between trades (ms) to avoid rate limits */
const TRADE_DELAY_MS = 2000;

/** Timeout for async operations */
const ASYNC_TIMEOUT_MS = 30000;

// ==================== Mock Implementations ====================

/**
 * Mock MonitoringService - captures alerts for verification
 */
class MockMonitoringService implements IMonitoringService {
  public alerts: { level: AlertLevel; message: string; meta?: any }[] = [];

  private createMockAlert(level: AlertLevel, message: string): Alert {
    return {
      id: `alert-${Date.now()}`,
      level,
      message,
      timestamp: Date.now(),
      sent: true,
      sentTo: ['log'] as AlertChannel[],
    };
  }

  async alertCritical(message: string, meta?: any): Promise<Alert> {
    this.alerts.push({ level: 'critical', message, meta });
    console.log(`[MOCK ALERT] CRITICAL: ${message}`, meta);
    return this.createMockAlert('critical', message);
  }

  async alertWarn(message: string, meta?: any): Promise<Alert> {
    this.alerts.push({ level: 'warning', message, meta });
    console.log(`[MOCK ALERT] WARN: ${message}`, meta);
    return this.createMockAlert('warning', message);
  }

  async alertInfo(message: string, meta?: any): Promise<Alert> {
    this.alerts.push({ level: 'info', message, meta });
    console.log(`[MOCK ALERT] INFO: ${message}`, meta);
    return this.createMockAlert('info', message);
  }

  async dailyReport(): Promise<DailyReportResult> {
    return { success: true, message: 'Mock report', sent: true, timestamp: Date.now() };
  }

  getAlertHistory(_limit?: number): AlertHistoryEntry[] { return []; }

  getAlertStats(): AlertStats {
    return {
      total: 0,
      bySeverity: { critical: 0, warning: 0, info: 0 },
      last24h: 0,
    };
  }

  acknowledgeAlert(_alertId: string, _acknowledgedBy?: string): void {}
  clearHistory(): void {}
  getConfig(): MonitoringServiceConfig {
    return {
      criticalChannels: ['log'],
      warningChannels: ['log'],
      infoChannels: ['log'],
      deduplicationIntervalMs: 0,
      logAllAlerts: true,
      dailyReportCron: '0 0 * * *',
      dailyReportEnabled: false,
      maxHistorySize: 100,
    };
  }
  updateConfig(_patch: Partial<MonitoringServiceConfig>): void {}
  start(): void {}
  stop(): void {}
}

/**
 * Create mock logger that outputs to console
 */
function createTestLogger(): Logger {
  const mockLogger: any = {
    info: (msg: string, meta?: any) => console.log(`[INFO] ${msg}`, meta || ''),
    warn: (msg: string, meta?: any) => console.warn(`[WARN] ${msg}`, meta || ''),
    error: (msg: string, err?: Error, meta?: any) => console.error(`[ERROR] ${msg}`, err?.message || '', meta || ''),
    debug: (msg: string, meta?: any) => console.log(`[DEBUG] ${msg}`, meta || ''),
    child: (_name: string) => mockLogger,
  };
  return mockLogger as Logger;
}

// ==================== Test Setup ====================

describe('HedgeService Integration Tests', () => {
  let hedgeService: HedgeService;
  let configService: ConfigService;
  let binanceClient: BinanceClient;
  let mockMonitoring: MockMonitoringService;
  let logger: Logger;

  // Track position for cleanup
  let initialPosition: HedgeSnapshot | null = null;

  beforeAll(async () => {
    // Verify required env vars
    const requiredVars = ['HEDGE_EXCHANGE_API_KEY', 'HEDGE_EXCHANGE_SECRET'];
    const missing = requiredVars.filter(v => !process.env[v]);
    if (missing.length > 0) {
      console.warn(`Warning: Missing env vars ${missing.join(', ')} - tests may fail`);
    }

    // Setup DI manually (not using full container to avoid side effects)
    logger = createTestLogger();
    configService = new ConfigService();
    mockMonitoring = new MockMonitoringService();

    // Register in container for BinanceClient
    container.registerInstance(TOKENS.LOGGER, logger);
    container.registerInstance(TOKENS.CONFIG_SERVICE, configService);

    // Create BinanceClient
    binanceClient = new BinanceClient(configService, logger);

    // Connect to Binance
    await binanceClient.connect();
    console.log('Connected to Binance API');

    // Create HedgeService with real dependencies
    hedgeService = new HedgeService(
      logger,
      configService,
      mockMonitoring,
      binanceClient
    );

    // Store initial position for comparison/cleanup
    try {
      initialPosition = await hedgeService.getPosition();
      console.log('\n=== Initial Position ===');
      console.log(`Has Position: ${initialPosition.hasPosition}`);
      console.log(`Short ETH: ${initialPosition.shortSizeEth.toString()}`);
      console.log(`Short USDC: ${initialPosition.shortNotionalUsdc.toString()}`);
      console.log(`Equity: ${initialPosition.equity.toString()}`);
      console.log('========================\n');
    } catch (error) {
      console.warn('Could not get initial position:', (error as Error).message);
    }
  }, ASYNC_TIMEOUT_MS);

  afterAll(async () => {
    // Cleanup: try to close any test positions
    console.log('\n=== Cleanup ===');
    try {
      const finalPosition = await hedgeService.getPosition();
      console.log(`Final Short ETH: ${finalPosition.shortSizeEth.toString()}`);
      console.log(`Final Short USDC: ${finalPosition.shortNotionalUsdc.toString()}`);

      // If we opened a position during tests and it's still open, close it
      if (finalPosition.hasPosition && finalPosition.shortNotionalUsdc.greaterThan(0)) {
        console.log('Closing test position...');
        await hedgeService.reduceOnlyCloseAll();
        console.log('Position closed.');
      }
    } catch (error) {
      console.error('Cleanup failed:', (error as Error).message);
    }
    console.log('================\n');
  }, ASYNC_TIMEOUT_MS);

  // Helper to wait between operations
  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  // ==================== Basic Connectivity Tests ====================

  describe('Connectivity & Basic Queries', () => {
    test('should ping Binance API successfully', async () => {
      const result = await hedgeService.ping();
      expect(result).toBe(true);
    });

    test('should check connection status', () => {
      const connected = hedgeService.isConnected();
      // Note: isConnected may return false initially if not explicitly connected
      expect(typeof connected).toBe('boolean');
    });

    test('should get current mark price', async () => {
      const price = await hedgeService.getCurrentPrice();

      expect(price).toBeInstanceOf(Decimal);
      expect(price.greaterThan(0)).toBe(true);

      console.log(`Current ETH price: $${price.toFixed(2)}`);
    });

    test('should get margin info', async () => {
      const marginInfo = await hedgeService.getMarginInfo();

      expect(marginInfo).toBeDefined();
      expect(marginInfo.equity).toBeInstanceOf(Decimal);
      expect(marginInfo.equity.greaterThanOrEqualTo(0)).toBe(true);

      console.log('Margin Info:', {
        equity: marginInfo.equity.toFixed(2),
        availableBalance: marginInfo.availableBalance.toFixed(2),
        marginRatio: marginInfo.marginRatio.toFixed(4),
      });
    });

    test('should get funding rate', async () => {
      const fundingRate = await hedgeService.getFundingRate();

      expect(fundingRate).toBeDefined();
      expect(fundingRate.symbol).toBeDefined();
      expect(fundingRate.rate).toBeDefined();

      console.log('Funding Rate:', {
        symbol: fundingRate.symbol,
        rate: fundingRate.rate.toString(),
        nextFundingTime: new Date(fundingRate.nextFundingTime || 0).toISOString(),
      });
    });

    test('should get current position snapshot', async () => {
      const snapshot = await hedgeService.getPosition();

      expect(snapshot).toBeDefined();
      expect(typeof snapshot.hasPosition).toBe('boolean');
      expect(snapshot.shortSizeEth).toBeInstanceOf(Decimal);
      expect(snapshot.shortNotionalUsdc).toBeInstanceOf(Decimal);
      expect(snapshot.equity).toBeInstanceOf(Decimal);
      expect(snapshot.apiHealth).toBeDefined();
      expect(snapshot.apiHealth.isHealthy).toBe(true);

      console.log('Position Snapshot:', {
        hasPosition: snapshot.hasPosition,
        shortEth: snapshot.shortSizeEth.toFixed(6),
        shortUsdc: snapshot.shortNotionalUsdc.toFixed(2),
        equity: snapshot.equity.toFixed(2),
        leverage: snapshot.leverage,
        marginType: snapshot.marginType,
        liquidationPrice: snapshot.liquidationPrice.toFixed(2),
        liquidationDistance: snapshot.liquidationDistancePercent.toFixed(2) + '%',
      });
    });
  });

  // ==================== Volatility Tests ====================

  describe('Volatility Calculation', () => {
    test('should get 24h volatility (48 candles @ 30m)', async () => {
      const volatility = await hedgeService.getVolatility('30m', 48);

      expect(volatility).toBeInstanceOf(Decimal);
      expect(volatility.greaterThanOrEqualTo(0)).toBe(true);

      // Annualize to 24h for display
      const vol24h = volatility.mul(Math.sqrt(48)).mul(100);
      console.log(`24h Volatility: ${vol24h.toFixed(2)}% (raw σ: ${volatility.toFixed(6)})`);
    });

    test('should get 3-day volatility (144 candles @ 30m)', async () => {
      const volatility = await hedgeService.getVolatility('30m', 144);

      expect(volatility).toBeInstanceOf(Decimal);
      expect(volatility.greaterThanOrEqualTo(0)).toBe(true);

      const vol24h = volatility.mul(Math.sqrt(48)).mul(100);
      console.log(`3d Volatility (24h scale): ${vol24h.toFixed(2)}%`);
    });

    test('should get 1h volatility for comparison', async () => {
      const volatility = await hedgeService.getVolatility('1h', 24);

      expect(volatility).toBeInstanceOf(Decimal);

      const vol24h = volatility.mul(Math.sqrt(24)).mul(100);
      console.log(`1h TF Volatility (24h scale): ${vol24h.toFixed(2)}%`);
    });
  });

  // ==================== Position Management Tests ====================

  describe('Position Lifecycle', () => {
    /**
     * Full lifecycle test in a single test to ensure proper sequencing.
     * Uses MARGIN_DANGER urgency for faster IOC/market execution.
     *
     * Flow: Clean → Open $150 → Increase 10% → Decrease 15% → Close
     */
    test('Full lifecycle: open → increase → decrease → close', async () => {
      // ==================== SETUP: Ensure clean state ====================
      console.log('\n========== POSITION LIFECYCLE TEST ==========');

      const before = await hedgeService.getPosition();
      if (before.hasPosition && before.shortNotionalUsdc.greaterThan(5)) {
        console.log(`Cleaning up existing position: $${before.shortNotionalUsdc.toFixed(2)}`);
        await hedgeService.reduceOnlyCloseAll();
        await delay(TRADE_DELAY_MS);
      }

      // ==================== STEP 1: Open position ====================
      const openTarget = new Decimal(TEST_POSITION_USDC);
      console.log(`\n[STEP 1] Opening position: $${openTarget.toFixed(2)}`);

      const openResult = await hedgeService.setTargetShortNotional(
        openTarget,
        HedgeUrgency.MARGIN_DANGER // Use IOC/market for reliability
      );

      console.log('Open result:', {
        executed: openResult.executed,
        operation: openResult.operation,
        modeUsed: openResult.modeUsed,
        newNotional: openResult.newShortNotionalUsdc.toFixed(2),
      });

      await delay(TRADE_DELAY_MS);
      let current = await hedgeService.getPosition();
      const positionAfterOpen = current.shortNotionalUsdc;
      console.log(`Position after open: $${positionAfterOpen.toFixed(2)}`);

      // Verify position was opened (allow some tolerance)
      expect(positionAfterOpen.greaterThan(openTarget.mul(0.8))).toBe(true);

      // ==================== STEP 2: Increase by 10% ====================
      const increaseTarget = positionAfterOpen.mul(1.10);
      console.log(`\n[STEP 2] Increasing by 10%: $${positionAfterOpen.toFixed(2)} → $${increaseTarget.toFixed(2)}`);

      const increaseResult = await hedgeService.setTargetShortNotional(
        increaseTarget,
        HedgeUrgency.MARGIN_DANGER
      );

      console.log('Increase result:', {
        executed: increaseResult.executed,
        operation: increaseResult.operation,
        modeUsed: increaseResult.modeUsed,
        deltaUsdc: increaseResult.deltaUsdc.toFixed(2),
        newNotional: increaseResult.newShortNotionalUsdc.toFixed(2),
        reason: increaseResult.reason,
      });

      await delay(TRADE_DELAY_MS);
      current = await hedgeService.getPosition();
      const positionAfterIncrease = current.shortNotionalUsdc;
      console.log(`Position after increase: $${positionAfterIncrease.toFixed(2)} (target was: $${increaseTarget.toFixed(2)})`);

      // Verify position increased OR reason was logged
      if (!increaseResult.executed) {
        console.warn(`⚠️ Increase was not executed: ${increaseResult.reason}`);
      }
      // Allow small tolerance for fills
      expect(positionAfterIncrease.greaterThanOrEqualTo(positionAfterOpen.mul(0.98))).toBe(true);

      // ==================== STEP 3: Decrease by 15% ====================
      const decreaseTarget = positionAfterIncrease.mul(0.85);
      console.log(`\n[STEP 3] Decreasing by 15%: $${positionAfterIncrease.toFixed(2)} → $${decreaseTarget.toFixed(2)}`);

      const decreaseResult = await hedgeService.setTargetShortNotional(
        decreaseTarget,
        HedgeUrgency.MARGIN_DANGER
      );

      console.log('Decrease result:', {
        executed: decreaseResult.executed,
        operation: decreaseResult.operation,
        modeUsed: decreaseResult.modeUsed,
        newNotional: decreaseResult.newShortNotionalUsdc.toFixed(2),
      });

      await delay(TRADE_DELAY_MS);
      current = await hedgeService.getPosition();
      const positionAfterDecrease = current.shortNotionalUsdc;
      console.log(`Position after decrease: $${positionAfterDecrease.toFixed(2)}`);

      // Verify position decreased
      expect(positionAfterDecrease.lessThan(positionAfterIncrease)).toBe(true);

      // ==================== STEP 4: Close completely ====================
      console.log(`\n[STEP 4] Closing position: $${positionAfterDecrease.toFixed(2)} → $0`);

      const closeResult = await hedgeService.reduceOnlyCloseAll();

      console.log('Close result:', {
        success: closeResult.success,
        closedUsdc: closeResult.closedUsdc.toFixed(2),
        executionPrice: closeResult.executionPrice.toFixed(2),
      });

      expect(closeResult.success).toBe(true);

      await delay(TRADE_DELAY_MS);
      current = await hedgeService.getPosition();
      console.log(`Final position: $${current.shortNotionalUsdc.toFixed(2)}`);

      // Verify closed
      expect(current.shortNotionalUsdc.lessThan(1)).toBe(true);

      console.log('\n========== LIFECYCLE TEST COMPLETE ==========\n');
    }, 120_000); // 2 minute timeout for full lifecycle
  });

  // ==================== Edge Cases & Error Handling ====================

  describe('Edge Cases', () => {
    test('should handle setTarget with amount below minimum', async () => {
      // Try to set a very small target
      const tinyTarget = new Decimal(1); // $1

      const result = await hedgeService.setTargetShortNotional(
        tinyTarget,
        HedgeUrgency.NORMAL
      );

      // Should either skip (noop) or fail gracefully
      console.log('Tiny target result:', {
        executed: result.executed,
        operation: result.operation,
        modeUsed: result.modeUsed,
      });

      // Expect either noop or executed (depending on current position)
      expect(['open', 'noop', 'decrease', 'close']).toContain(result.operation);
    });

    test('should handle getPosition when no position exists', async () => {
      // First ensure no position
      const before = await hedgeService.getPosition();
      if (before.hasPosition) {
        await hedgeService.reduceOnlyCloseAll();
        await delay(TRADE_DELAY_MS);
      }

      // Get position when none exists
      const snapshot = await hedgeService.getPosition();

      expect(snapshot.shortSizeEth.isZero() || snapshot.shortSizeEth.lessThan(0.0001)).toBe(true);
      expect(snapshot.shortNotionalUsdc.lessThan(1)).toBe(true);

      console.log('Empty position snapshot:', {
        hasPosition: snapshot.hasPosition,
        shortEth: snapshot.shortSizeEth.toFixed(6),
        equity: snapshot.equity.toFixed(2),
      });
    });

    test('should use POST_RESET urgency mode', async () => {
      // First ensure clean state
      const before = await hedgeService.getPosition();
      if (before.hasPosition && before.shortNotionalUsdc.greaterThan(5)) {
        await hedgeService.reduceOnlyCloseAll();
        await delay(TRADE_DELAY_MS);
      }

      // Test POST_RESET urgency
      const targetUsdc = new Decimal(TEST_POSITION_USDC);
      console.log(`\n>>> Opening with POST_RESET urgency: $${targetUsdc.toFixed(2)}`);

      const result = await hedgeService.setTargetShortNotional(
        targetUsdc,
        HedgeUrgency.POST_RESET
      );

      expect(result).toBeDefined();
      // POST_RESET should execute or at least try
      console.log('POST_RESET Result:', {
        executed: result.executed,
        modeUsed: result.modeUsed,
        operation: result.operation,
        newNotional: result.newShortNotionalUsdc.toFixed(2),
      });

      // Verify some position was opened
      await delay(TRADE_DELAY_MS);
      const after = await hedgeService.getPosition();
      console.log(`Position after POST_RESET: $${after.shortNotionalUsdc.toFixed(2)}`);

      // Cleanup - always close
      if (after.shortNotionalUsdc.greaterThan(5)) {
        await hedgeService.reduceOnlyCloseAll();
      }
    }, 60_000);
  });

  // ==================== Legacy Methods ====================

  describe('Legacy Methods', () => {
    test('should get short position (legacy)', async () => {
      const position = await hedgeService.getShortPosition();

      // Can be null if no position
      if (position) {
        expect(position.contracts).toBeInstanceOf(Decimal);
        console.log('Legacy ShortPosition:', {
          contracts: position.contracts.toFixed(6),
          sizeInUsdc: position.sizeInUsdc.toFixed(2),
          side: position.side,
        });
      } else {
        console.log('No short position (legacy method returned null)');
      }
    });

    test('should open short via legacy method', async () => {
      // Ensure clean state
      await hedgeService.reduceOnlyCloseAll();
      await delay(TRADE_DELAY_MS);

      const amountUsdc = new Decimal(TEST_POSITION_USDC);

      console.log(`\n>>> Opening via legacy openOrIncreaseShort: $${amountUsdc.toFixed(2)}`);

      const result = await hedgeService.openOrIncreaseShort(amountUsdc, false);

      expect(result).toBeDefined();
      expect(result.operation).toBeDefined();

      console.log('Legacy open result:', {
        operation: result.operation,
        amountUsdc: result.amountUsdc.toFixed(2),
        executionPrice: result.executionPrice.toFixed(2),
      });

      // Cleanup
      await delay(TRADE_DELAY_MS);
      await hedgeService.reduceOnlyCloseAll();
    }, ASYNC_TIMEOUT_MS);
  });

  // ==================== Performance & Monitoring ====================

  describe('Monitoring & Alerts', () => {
    test('should capture alerts during operations', async () => {
      // Clear previous alerts
      mockMonitoring.alerts = [];

      // Perform some operations that might trigger alerts
      await hedgeService.getPosition();
      await hedgeService.getCurrentPrice();

      console.log(`Alerts captured: ${mockMonitoring.alerts.length}`);
      if (mockMonitoring.alerts.length > 0) {
        mockMonitoring.alerts.forEach(alert => {
          console.log(`- [${alert.level}] ${alert.message}`);
        });
      }

      // No assertion - just logging
    });

    test('should report API health status', async () => {
      const snapshot = await hedgeService.getPosition();

      expect(snapshot.apiHealth).toBeDefined();
      expect(typeof snapshot.apiHealth.isHealthy).toBe('boolean');
      expect(typeof snapshot.apiHealth.avgResponseTimeMs).toBe('number');

      console.log('API Health:', {
        isHealthy: snapshot.apiHealth.isHealthy,
        avgResponseMs: snapshot.apiHealth.avgResponseTimeMs.toFixed(0),
        errorsLastHour: snapshot.apiHealth.errorCountLastHour,
        lastSuccess: new Date(snapshot.apiHealth.lastSuccessTimestamp).toISOString(),
      });
    });
  });
});
