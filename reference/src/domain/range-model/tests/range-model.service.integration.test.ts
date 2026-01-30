/**
 * Integration Tests for RangeModelService
 *
 * Tests dynamic LP range calculation based on 1d and 3d volatility windows.
 *
 * Mock Strategy:
 * - HedgeService: returns controlled volatility values
 * - ConfigService: uses realistic lpRange config
 * - Logger: minimal mock
 */

import 'reflect-metadata';
import Decimal from 'decimal.js';
import { RangeModelService } from '../range-model.service';
import { VolatilityRegime, DynamicRangeResult } from '../range-model.types';
import type { IHedgeService } from '../../hedge/hedge.interface';
import type { ConfigService } from '../../../config';
import type { ILogger, Logger } from '../../../infra/logger/logger';

// ==================== Mock Implementations ====================

/**
 * Create mock logger that captures logs for debugging
 */
function createMockLogger(): Logger {
  const logs: { level: string; message: string; meta?: any }[] = [];

  const mockLoggerInstance: ILogger = {
    info: (message: string, meta?: any) => logs.push({ level: 'info', message, meta }),
    warn: (message: string, meta?: any) => logs.push({ level: 'warn', message, meta }),
    error: (message: string, _error?: Error | null, meta?: any) => logs.push({ level: 'error', message, meta }),
    debug: (message: string, meta?: any) => logs.push({ level: 'debug', message, meta }),
    child: (_serviceName: string) => mockLoggerInstance,
  };

  return mockLoggerInstance as Logger;
}

/**
 * Create mock ConfigService with custom lpRange
 */
function createMockConfigService(overrides: Partial<{
  rangeWidthPercent: number;
  rangeMinPercent: number;
  rangeMaxPercent: number;
  hedgeSymbol: string;
}> = {}): ConfigService {
  return {
    lpRange: {
      rangeWidthPercent: overrides.rangeWidthPercent ?? 0.05, // 5% default
      rangeMinPercent: overrides.rangeMinPercent ?? 0.03,     // 3% min
      rangeMaxPercent: overrides.rangeMaxPercent ?? 0.15,     // 15% max
      symmetricRange: true,
      minTickSpacingMultiplier: 2,
      autoCreateEnabled: false,
    },
    hedgeExchange: {
      hedgeSymbol: overrides.hedgeSymbol ?? 'ETH/USDT:USDT',
    },
  } as ConfigService;
}

/**
 * Create mock HedgeService with controlled volatility responses
 *
 * @param volatilityMap - Maps candle limit to raw volatility (per-bar σ)
 *                        Use limit to distinguish 1d vs 3d windows:
 *                        - 1d with 30m candles = 48 candles
 *                        - 3d with 30m candles = 144 candles
 */
function createMockHedgeService(volatilityMap: Map<number, Decimal>): IHedgeService {
  return {
    getVolatility: jest.fn(async (_timeframe: string, limit?: number): Promise<Decimal> => {
      const candleLimit = limit ?? 48;
      const vol = volatilityMap.get(candleLimit);
      if (vol !== undefined) {
        return vol;
      }
      // Fallback: linear interpolation for unknown limits
      // This handles edge cases in the service
      const defaultVol = volatilityMap.get(48) ?? new Decimal(0.001);
      return defaultVol;
    }),
    // Other methods not used in RangeModelService
    getPosition: jest.fn(),
    setTargetShortNotional: jest.fn(),
    reduceOnlyCloseAll: jest.fn(),
    getShortPosition: jest.fn(),
    getMarginInfo: jest.fn(),
    reduceOnlyClose: jest.fn(),
    openOrIncreaseShort: jest.fn(),
    decreaseShort: jest.fn(),
    getCurrentPrice: jest.fn(),
    isConnected: jest.fn(() => true),
    connect: jest.fn(),
    disconnect: jest.fn(),
    syncWithLpPosition: jest.fn(),
    ping: jest.fn(async () => true),
    getFundingRate: jest.fn(),
  } as unknown as IHedgeService;
}

/**
 * Helper: Convert 24h annualized volatility (%) to raw per-bar volatility
 *
 * For 30m candles: raw = vol24h / sqrt(48) / 100
 * Example: 5% 24h vol → 0.00722 per-bar
 */
function vol24hToRaw(vol24hPercent: number, timeframeMinutes = 30): Decimal {
  const periodsIn24h = (24 * 60) / timeframeMinutes; // 48 for 30m
  return new Decimal(vol24hPercent).div(100).div(new Decimal(periodsIn24h).sqrt());
}

// ==================== Test Suites ====================

describe('RangeModelService', () => {
  let logger: Logger;
  let configService: ConfigService;
  let hedgeService: IHedgeService;
  let rangeModelService: RangeModelService;

  beforeEach(() => {
    logger = createMockLogger();
  });

  // ==================== Volatility Regime Classification ====================

  describe('Volatility Regime Classification', () => {
    const regimeTestCases: {
      name: string;
      vol24h: number;
      expectedRegime: VolatilityRegime;
      expectedRangeMin: number;
      expectedRangeMax: number;
    }[] = [
      { name: 'ULTRA_CALM (0.5%)', vol24h: 0.5, expectedRegime: VolatilityRegime.ULTRA_CALM, expectedRangeMin: 3, expectedRangeMax: 4 },
      { name: 'ULTRA_CALM (1.0%)', vol24h: 1.0, expectedRegime: VolatilityRegime.ULTRA_CALM, expectedRangeMin: 3, expectedRangeMax: 4 },
      { name: 'CALM (2.0%)', vol24h: 2.0, expectedRegime: VolatilityRegime.CALM, expectedRangeMin: 5, expectedRangeMax: 6 },
      { name: 'CALM (2.5%)', vol24h: 2.5, expectedRegime: VolatilityRegime.CALM, expectedRangeMin: 5, expectedRangeMax: 6 },
      { name: 'NORMAL (4.0%)', vol24h: 4.0, expectedRegime: VolatilityRegime.NORMAL, expectedRangeMin: 7, expectedRangeMax: 10 },
      { name: 'NORMAL (4.5%)', vol24h: 4.5, expectedRegime: VolatilityRegime.NORMAL, expectedRangeMin: 7, expectedRangeMax: 10 },
      { name: 'VOLATILE (6.0%)', vol24h: 6.0, expectedRegime: VolatilityRegime.VOLATILE, expectedRangeMin: 12, expectedRangeMax: 15 },
      { name: 'VOLATILE (7.5%)', vol24h: 7.5, expectedRegime: VolatilityRegime.VOLATILE, expectedRangeMin: 12, expectedRangeMax: 15 },
      { name: 'CHAOS (10.0%)', vol24h: 10.0, expectedRegime: VolatilityRegime.CHAOS, expectedRangeMin: 15, expectedRangeMax: 25 },
      { name: 'CHAOS (15.0%)', vol24h: 15.0, expectedRegime: VolatilityRegime.CHAOS, expectedRangeMin: 15, expectedRangeMax: 25 },
    ];

    test.each(regimeTestCases)(
      'should classify $name vol as $expectedRegime with range [$expectedRangeMin-$expectedRangeMax]%',
      async ({ vol24h, expectedRegime, expectedRangeMin, expectedRangeMax }) => {
        // Setup: same volatility for 1d and 3d (stable regime)
        const rawVol = vol24hToRaw(vol24h);
        const volMap = new Map<number, Decimal>([
          [48, rawVol],   // 1d window
          [144, rawVol],  // 3d window
        ]);

        configService = createMockConfigService();
        hedgeService = createMockHedgeService(volMap);
        rangeModelService = new RangeModelService(logger, configService, hedgeService);

        const result = await rangeModelService.calculateDynamicRange();

        expect(result.regime).toBe(expectedRegime);
        expect(result.rangeWidthPercent.toNumber()).toBeGreaterThanOrEqual(expectedRangeMin);
        expect(result.rangeWidthPercent.toNumber()).toBeLessThanOrEqual(expectedRangeMax);
        expect(result.lpEnabled).toBe(true); // LP enabled by default even in chaos
      }
    );
  });

  // ==================== Dual-Window Volatility Blending ====================

  describe('Dual-Window Volatility Blending', () => {
    test('should detect RISING trend when 1d vol >> 3d vol (spike ratio > 1.5)', async () => {
      // 1d: 6% (volatile), 3d: 3% (normal) → spike ratio = 2.0
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(6.0)],   // 1d
        [144, vol24hToRaw(3.0)],  // 3d
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.volatilityTrend).toBe('RISING');
      expect(result.spikeRatio.toNumber()).toBeCloseTo(2.0, 1);
      // Effective vol should be weighted towards 1d (80/20)
      // Expected: 6*0.8 + 3*0.2 = 5.4%
      expect(result.volatility24h.toNumber()).toBeGreaterThan(5.0);
    });

    test('should detect FALLING trend when 1d vol << 3d vol (spike ratio < 0.7)', async () => {
      // 1d: 2% (calm), 3d: 5% (normal) → spike ratio = 0.4
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(2.0)],   // 1d
        [144, vol24hToRaw(5.0)],  // 3d
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.volatilityTrend).toBe('FALLING');
      expect(result.spikeRatio.toNumber()).toBeCloseTo(0.4, 1);
      // Effective vol should be weighted towards 3d (40/60)
      // Expected: 2*0.4 + 5*0.6 = 3.8%, but floor = max(2,5)*0.85 = 4.25%
      expect(result.volatility24h.toNumber()).toBeGreaterThanOrEqual(4.0);
    });

    test('should detect STABLE trend when 1d vol ≈ 3d vol (spike ratio 0.7-1.5)', async () => {
      // 1d: 4%, 3d: 4.5% → spike ratio ≈ 0.89 (stable)
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(4.0)],
        [144, vol24hToRaw(4.5)],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.volatilityTrend).toBe('STABLE');
      expect(result.spikeRatio.toNumber()).toBeGreaterThan(0.7);
      expect(result.spikeRatio.toNumber()).toBeLessThan(1.5);
    });

    test('should apply floor protection (never below max(1d,3d) * 0.85)', async () => {
      // Edge case: 1d = 1%, 3d = 6%
      // Blend: 1*0.4 + 6*0.6 = 4.0%
      // Floor: max(1,6) * 0.85 = 5.1%
      // Effective should be 5.1% (floor applied)
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(1.0)],
        [144, vol24hToRaw(6.0)],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      // Effective should be at least 5.1% (floor)
      expect(result.volatility24h.toNumber()).toBeGreaterThanOrEqual(5.0);
    });
  });

  // ==================== Range Clamping ====================

  describe('Range Clamping', () => {
    test('should clamp range to minimum (3%) when calculated range is lower', async () => {
      // Very low volatility → ultra calm → would suggest 3-4%
      // With min=3%, should be at least 3%
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(0.3)],
        [144, vol24hToRaw(0.3)],
      ]);

      configService = createMockConfigService({ rangeMinPercent: 0.03 }); // 3%
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.rangeWidthPercent.toNumber()).toBeGreaterThanOrEqual(3);
    });

    test('should clamp range to maximum (15%) when calculated range is higher', async () => {
      // Very high volatility → chaos → would suggest 20-25%
      // With max=15%, should be capped at 15%
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(12.0)],
        [144, vol24hToRaw(12.0)],
      ]);

      configService = createMockConfigService({ rangeMaxPercent: 0.15 }); // 15%
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.rangeWidthPercent.toNumber()).toBeLessThanOrEqual(15);
    });

    test('should respect custom min/max bounds', async () => {
      // Custom bounds: 5% min, 10% max
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(4.0)],
        [144, vol24hToRaw(4.0)],
      ]);

      configService = createMockConfigService({
        rangeMinPercent: 0.05, // 5%
        rangeMaxPercent: 0.10, // 10%
      });
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.rangeWidthPercent.toNumber()).toBeGreaterThanOrEqual(5);
      expect(result.rangeWidthPercent.toNumber()).toBeLessThanOrEqual(10);
    });
  });

  // ==================== Expected Move Calculation ====================

  describe('Expected Move Calculation', () => {
    test('should calculate expected move based on 1d volatility', async () => {
      // 5% 24h volatility → expected move for 24h should be ~5%
      const vol1d = 5.0;
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(vol1d)],
        [144, vol24hToRaw(vol1d)],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      // Expected move should be approximately equal to 24h vol
      expect(result.expectedMovePercent.toNumber()).toBeCloseTo(vol1d, 0);
    });

    test('should calculate expected move for custom horizon', async () => {
      const vol1d = 4.0;
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(vol1d)],
        [144, vol24hToRaw(vol1d)],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      // Test 12h expected move (should be vol * sqrt(12/24) = vol * 0.707)
      const expectedMove = await rangeModelService.getExpectedMove(12);

      expect(expectedMove.toNumber()).toBeCloseTo(vol1d * Math.sqrt(0.5), 0);
    });
  });

  // ==================== LP Disable in Chaos ====================

  describe('LP Disable in Chaos', () => {
    test('should keep LP enabled by default even in chaos regime', async () => {
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(12.0)], // Chaos level
        [144, vol24hToRaw(12.0)],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.regime).toBe(VolatilityRegime.CHAOS);
      expect(result.lpEnabled).toBe(true); // Default: not disabled
    });

    test('should disable LP in chaos when disableLpInChaos is true', async () => {
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(12.0)],
        [144, vol24hToRaw(12.0)],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      // Update config to disable LP in chaos
      rangeModelService.updateConfig({ disableLpInChaos: true });

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.regime).toBe(VolatilityRegime.CHAOS);
      expect(result.lpEnabled).toBe(false);
    });

    test('shouldDisableLp should return correct value', async () => {
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(12.0)],
        [144, vol24hToRaw(12.0)],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      // Default: should not disable
      let shouldDisable = await rangeModelService.shouldDisableLp();
      expect(shouldDisable).toBe(false);

      // Enable disableLpInChaos
      rangeModelService.updateConfig({ disableLpInChaos: true });
      shouldDisable = await rangeModelService.shouldDisableLp();
      expect(shouldDisable).toBe(true);
    });
  });

  // ==================== Volatility Details API ====================

  describe('Volatility Details API', () => {
    test('should return detailed volatility breakdown', async () => {
      const vol1d = 5.0;
      const vol3d = 4.0;
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(vol1d)],
        [144, vol24hToRaw(vol3d)],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const details = await rangeModelService.getVolatilityDetails();

      expect(details.vol1d_24h.toNumber()).toBeCloseTo(vol1d, 0);
      expect(details.vol3d_24h.toNumber()).toBeCloseTo(vol3d, 0);
      expect(details.spikeRatio.toNumber()).toBeCloseTo(vol1d / vol3d, 1);
      expect(details.trend).toBe('STABLE'); // 1.25 is stable
    });

    test('should cache volatility for 5 minutes', async () => {
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(5.0)],
        [144, vol24hToRaw(5.0)],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      // First call
      await rangeModelService.getVolatilityDetails();
      const callCount1 = (hedgeService.getVolatility as jest.Mock).mock.calls.length;

      // Second call (should use cache)
      await rangeModelService.getVolatilityDetails();
      const callCount2 = (hedgeService.getVolatility as jest.Mock).mock.calls.length;

      expect(callCount2).toBe(callCount1); // No additional calls
    });
  });

  // ==================== Error Handling ====================

  describe('Error Handling', () => {
    test('should return fallback result when volatility fetch fails', async () => {
      configService = createMockConfigService();
      hedgeService = {
        ...createMockHedgeService(new Map()),
        getVolatility: jest.fn().mockRejectedValue(new Error('API error')),
      } as unknown as IHedgeService;
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      // Should return fallback
      expect(result.lpEnabled).toBe(true);
      expect(result.regime).toBe(VolatilityRegime.NORMAL);
      expect(result.reason).toContain('Error');
    });
  });

  // ==================== Config API ====================

  describe('Config API', () => {
    test('should return current config', async () => {
      configService = createMockConfigService({
        rangeMinPercent: 0.04,
        rangeMaxPercent: 0.12,
      });
      hedgeService = createMockHedgeService(new Map());
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const config = rangeModelService.getConfig();

      expect(config.minRangeWidthPercent).toBe(4);
      expect(config.maxRangeWidthPercent).toBe(12);
      expect(config.symbol).toBe('ETH/USDT:USDT');
    });

    test('should update config with patch', async () => {
      configService = createMockConfigService();
      hedgeService = createMockHedgeService(new Map());
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      rangeModelService.updateConfig({
        horizonHours: 12,
        volatilityTimeframe: '1h',
      });

      const config = rangeModelService.getConfig();
      expect(config.horizonHours).toBe(12);
      expect(config.volatilityTimeframe).toBe('1h');
    });
  });

  // ==================== Integration with Real Volatility Scenarios ====================

  describe('Real-World Volatility Scenarios', () => {
    test('Scenario: ETH calm day (vol ~2.5%)', async () => {
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(2.5)],
        [144, vol24hToRaw(2.8)],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.regime).toBe(VolatilityRegime.CALM);
      expect(result.rangeWidthPercent.toNumber()).toBeGreaterThanOrEqual(5);
      expect(result.rangeWidthPercent.toNumber()).toBeLessThanOrEqual(6);
      expect(result.lpEnabled).toBe(true);
    });

    test('Scenario: ETH volatile spike (1d: 8%, 3d: 4%)', async () => {
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(8.0)],   // Recent spike
        [144, vol24hToRaw(4.0)],  // Historical normal
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.volatilityTrend).toBe('RISING');
      expect(result.regime).toBe(VolatilityRegime.VOLATILE);
      // Should widen range to account for spike
      expect(result.rangeWidthPercent.toNumber()).toBeGreaterThanOrEqual(12);
    });

    test('Scenario: ETH calming down (1d: 3%, 3d: 7%)', async () => {
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(3.0)],   // Recent calm
        [144, vol24hToRaw(7.0)],  // Historical volatile
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.volatilityTrend).toBe('FALLING');
      // Should still respect the 3d history and not narrow too fast
      expect(result.volatility24h.toNumber()).toBeGreaterThan(4.0);
      expect(result.rangeWidthPercent.toNumber()).toBeGreaterThanOrEqual(7);
    });

    test('Scenario: Extreme chaos (vol > 15%)', async () => {
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(18.0)],
        [144, vol24hToRaw(15.0)],
      ]);

      configService = createMockConfigService({ rangeMaxPercent: 0.25 }); // 25% max
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.regime).toBe(VolatilityRegime.CHAOS);
      // Should hit the chaos range (20-25%)
      expect(result.rangeWidthPercent.toNumber()).toBeGreaterThanOrEqual(20);
    });
  });

  // ==================== Boundary Conditions ====================

  describe('Boundary Conditions', () => {
    test('should handle zero volatility gracefully', async () => {
      const volMap = new Map<number, Decimal>([
        [48, new Decimal(0)],
        [144, new Decimal(0)],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.regime).toBe(VolatilityRegime.ULTRA_CALM);
      expect(result.rangeWidthPercent.toNumber()).toBeGreaterThanOrEqual(3);
    });

    test('should handle spike ratio edge case (3d = 0)', async () => {
      const volMap = new Map<number, Decimal>([
        [48, vol24hToRaw(5.0)],
        [144, new Decimal(0)], // Zero 3d vol
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      // Should not crash, spikeRatio defaults to 1
      expect(result.spikeRatio.toNumber()).toBe(1);
    });

    test('should handle very small volatility values', async () => {
      const volMap = new Map<number, Decimal>([
        [48, new Decimal('0.00001')],
        [144, new Decimal('0.00001')],
      ]);

      configService = createMockConfigService();
      hedgeService = createMockHedgeService(volMap);
      rangeModelService = new RangeModelService(logger, configService, hedgeService);

      const result = await rangeModelService.calculateDynamicRange();

      expect(result.regime).toBe(VolatilityRegime.ULTRA_CALM);
      expect(result.rangeWidthPercent.toNumber()).toBeCloseTo(3, 0); // Clamped to min
    });
  });
});
