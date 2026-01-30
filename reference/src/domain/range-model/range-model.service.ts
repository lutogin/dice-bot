import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import type { IHedgeService } from '../hedge';
import { IRangeModelService } from './range-model.interface';
import {
  DynamicRangeResult,
  VolatilityRegime,
  VolatilityTrend,
  VolatilityDetails,
  RangeModelConfig,
  DEFAULT_RANGE_MODEL_CONFIG,
} from './range-model.types';

/**
 * Internal structure for dual-window volatility
 */
interface DualWindowVolatility {
  /** Raw per-bar σ from 1d window */
  raw1d: Decimal;
  /** Raw per-bar σ from 3d window */
  raw3d: Decimal;
  /** 1d volatility annualized to 24h (%) */
  vol1d_24h: Decimal;
  /** 3d volatility annualized to 24h (%) */
  vol3d_24h: Decimal;
  /** Effective blended volatility (%) */
  effective: Decimal;
  /** Spike ratio: vol1d / vol3d */
  spikeRatio: Decimal;
  /** Trend based on spike ratio */
  trend: VolatilityTrend;
}

/**
 * Range Model Service
 *
 * Calculates dynamic LP range width based on market volatility.
 *
 * Formula:
 * 1. Get realized volatility σ from OHLCV log-returns
 * 2. Annualize to 24h: vol24h = σ * sqrt(24h / timeframe)
 * 3. Classify into volatility regime
 * 4. Map regime to range width
 * 5. Clamp to min/max from config
 */
@injectable()
export class RangeModelService implements IRangeModelService {
  private readonly logger: ILogger;
  private config: RangeModelConfig;

  // Cache for dual-window volatility to avoid excessive API calls
  private cachedDualVol: DualWindowVolatility | null = null;
  private cachedAt: number = 0;
  private readonly cacheTtlMs = 5 * 60 * 1000; // 5 minutes

  // Spike detection thresholds
  private readonly SPIKE_THRESHOLD = 1.5;   // vol1d/vol3d > 1.5 = spike
  private readonly DROP_THRESHOLD = 0.7;    // vol1d/vol3d < 0.7 = drop
  private readonly FLOOR_FACTOR = 0.85;     // Floor = max(1d,3d) * 0.85

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE) private readonly configService: ConfigService,
    @inject(TOKENS.HEDGE_SERVICE) private readonly hedgeService: IHedgeService
  ) {
    this.logger = logger.child('RangeModelService');

    // Initialize config from lpRange
    // Config uses fractions (0.04 = 4%), internal uses percent (4 = 4%)
    const lpRange = this.configService.lpRange;

    // Convert from fraction to percent for internal use
    const minRange = lpRange.rangeMinPercent * 100;  // 0.04 → 4
    const maxRange = lpRange.rangeMaxPercent * 100;  // 0.15 → 15

    this.config = {
      ...DEFAULT_RANGE_MODEL_CONFIG,
      symbol: this.configService.hedgeExchange.hedgeSymbol,
      minRangeWidthPercent: minRange,  // From LP_RANGE_MIN_PERCENT (fraction → percent)
      maxRangeWidthPercent: maxRange,  // From LP_RANGE_MAX_PERCENT (fraction → percent)
    };

    this.logger.info('RangeModelService initialized', {
      symbol: this.config.symbol,
      minRange: `±${this.config.minRangeWidthPercent}%`,
      maxRange: `±${this.config.maxRangeWidthPercent}%`,
      timeframe: this.config.volatilityTimeframe,
      candleCount: this.config.volatilityCandleCount,
    });
  }

  /**
   * Calculate dynamic LP range width based on current volatility
   *
   * Uses dual-window volatility (1d + 3d) for robust estimation:
   * - 1d: reactive to recent changes (fast signal)
   * - 3d: stable baseline (slow signal)
   * - Effective: weighted blend with spike/drop detection
   */
  async calculateDynamicRange(): Promise<DynamicRangeResult> {
    try {
      // Step 1: Get dual-window volatility (1d + 3d)
      const dualVol = await this.getDualWindowVolatility();

      // Step 2: Calculate expected move using 1d vol (more reactive)
      const expectedMove = this.calculateExpectedMove(dualVol.raw1d, this.config.horizonHours);

      // Step 3: Classify regime using effective (blended) volatility
      const regime = this.classifyRegime(dualVol.effective);

      // Step 4: Check if LP should be disabled
      const lpEnabled = !(this.config.disableLpInChaos && regime === VolatilityRegime.CHAOS);

      // Step 5: Get range for regime using effective volatility
      let rangeWidth = this.getRangeForRegime(regime, dualVol.effective);

      // Step 6: Clamp to min/max
      rangeWidth = this.clampRange(rangeWidth);

      const result: DynamicRangeResult = {
        lpEnabled,
        rangeWidthPercent: rangeWidth,
        regime,

        // Volatility details
        volatility24h: dualVol.effective,
        volatility1d: dualVol.vol1d_24h,
        volatility3d: dualVol.vol3d_24h,
        rawVolatility: dualVol.raw1d,

        // Diagnostics
        spikeRatio: dualVol.spikeRatio,
        volatilityTrend: dualVol.trend,
        expectedMovePercent: expectedMove,

        // Meta
        calculatedAt: Date.now(),
        reason: this.buildReason(regime, dualVol, rangeWidth),
      };

      this.logger.info('Dynamic range calculated (dual-window)', {
        regime,
        vol1d: dualVol.vol1d_24h.toFixed(2) + '%',
        vol3d: dualVol.vol3d_24h.toFixed(2) + '%',
        volEffective: dualVol.effective.toFixed(2) + '%',
        spikeRatio: dualVol.spikeRatio.toFixed(2),
        trend: dualVol.trend,
        rangeWidth: '±' + rangeWidth.toFixed(1) + '%',
        expectedMove: expectedMove.toFixed(2) + '%',
        lpEnabled,
      });

      return result;
    } catch (error) {
      this.logger.error('Failed to calculate dynamic range', error as Error);

      // Return safe defaults on error
      return this.buildFallbackResult();
    }
  }

  /**
   * Build fallback result when calculation fails
   */
  private buildFallbackResult(): DynamicRangeResult {
    // Config uses fraction (0.10 = 10%), result uses percent (10 = 10%)
    const defaultRange = new Decimal(this.configService.lpRange.rangeWidthPercent).mul(100);
    return {
      lpEnabled: true,
      rangeWidthPercent: defaultRange,
      regime: VolatilityRegime.NORMAL,

      volatility24h: new Decimal(0),
      volatility1d: new Decimal(0),
      volatility3d: new Decimal(0),
      rawVolatility: new Decimal(0),

      spikeRatio: new Decimal(1),
      volatilityTrend: 'STABLE',
      expectedMovePercent: new Decimal(0),

      calculatedAt: Date.now(),
      reason: 'Error calculating volatility, using default range',
    };
  }

  /**
   * Get current volatility regime (uses effective volatility)
   */
  async getCurrentRegime(): Promise<VolatilityRegime> {
    const dualVol = await this.getDualWindowVolatility();
    return this.classifyRegime(dualVol.effective);
  }

  /**
   * Get 24h effective volatility (blended 1d + 3d)
   */
  async getVolatility24h(): Promise<Decimal> {
    const dualVol = await this.getDualWindowVolatility();
    return dualVol.effective;
  }

  /**
   * Get full dual-window volatility details
   */
  async getVolatilityDetails(): Promise<VolatilityDetails> {
    return this.getDualWindowVolatility();
  }

  /**
   * Calculate expected price move for given hours (uses 1d vol)
   */
  async getExpectedMove(hours: number): Promise<Decimal> {
    const dualVol = await this.getDualWindowVolatility();
    return this.calculateExpectedMove(dualVol.raw1d, hours);
  }

  /**
   * Check if LP should be disabled due to extreme volatility
   */
  async shouldDisableLp(): Promise<boolean> {
    if (!this.config.disableLpInChaos) {
      return false;
    }
    const regime = await this.getCurrentRegime();
    return regime === VolatilityRegime.CHAOS;
  }

  /**
   * Get current configuration
   */
  getConfig(): RangeModelConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(patch: Partial<RangeModelConfig>): void {
    this.config = { ...this.config, ...patch };
    this.logger.info('RangeModelService config updated', patch);
  }

  // ==================== Private Methods ====================

  /**
   * Get dual-window volatility (1d + 3d) with caching
   *
   * This is the core method that:
   * 1. Fetches raw volatility for both windows
   * 2. Annualizes both to 24h
   * 3. Calculates spike ratio and trend
   * 4. Blends into effective volatility
   */
  private async getDualWindowVolatility(): Promise<DualWindowVolatility> {
    const now = Date.now();

    // Return cached value if still valid
    if (this.cachedDualVol && (now - this.cachedAt) < this.cacheTtlMs) {
      return this.cachedDualVol;
    }

    // Calculate candle limits for each window
    const limit1d = this.getCandleLimitForWindowDays(1);
    const limit3d = this.getCandleLimitForWindowDays(3);

    // Fetch both volatilities in parallel
    const [raw1d, raw3d] = await Promise.all([
      this.hedgeService.getVolatility(this.config.volatilityTimeframe, limit1d),
      this.hedgeService.getVolatility(this.config.volatilityTimeframe, limit3d),
    ]);

    // Annualize both to 24h
    const vol1d_24h = this.annualizeTo24h(raw1d);
    const vol3d_24h = this.annualizeTo24h(raw3d);

    // Calculate spike ratio and trend
    const spikeRatio = vol3d_24h.isZero()
      ? new Decimal(1)
      : vol1d_24h.div(vol3d_24h);

    const trend = this.determineTrend(spikeRatio);

    // Calculate effective volatility with blending
    const effective = this.blendVolatility(vol1d_24h, vol3d_24h, spikeRatio);

    const result: DualWindowVolatility = {
      raw1d,
      raw3d,
      vol1d_24h,
      vol3d_24h,
      effective,
      spikeRatio,
      trend,
    };

    // Update cache
    this.cachedDualVol = result;
    this.cachedAt = now;

    this.logger.debug('Dual-window volatility calculated', {
      raw1d: raw1d.toFixed(6),
      raw3d: raw3d.toFixed(6),
      vol1d: vol1d_24h.toFixed(2) + '%',
      vol3d: vol3d_24h.toFixed(2) + '%',
      spikeRatio: spikeRatio.toFixed(2),
      trend,
      effective: effective.toFixed(2) + '%',
    });

    return result;
  }

  /**
   * Determine volatility trend from spike ratio
   */
  private determineTrend(spikeRatio: Decimal): VolatilityTrend {
    if (spikeRatio.greaterThan(this.SPIKE_THRESHOLD)) {
      return 'RISING';
    } else if (spikeRatio.lessThan(this.DROP_THRESHOLD)) {
      return 'FALLING';
    }
    return 'STABLE';
  }

  /**
   * Blend 1d and 3d volatility into effective volatility
   *
   * Logic:
   * - Normal: 60% 1d + 40% 3d (slightly prefer reactive)
   * - Spike (1d >> 3d): 80% 1d + 20% 3d (trust fast signal)
   * - Drop (1d << 3d): 40% 1d + 60% 3d (don't narrow too fast)
   *
   * Floor: Never go below max(1d, 3d) * FLOOR_FACTOR
   * This prevents the blend from being lower than both inputs
   */
  private blendVolatility(vol1d: Decimal, vol3d: Decimal, spikeRatio: Decimal): Decimal {
    let blended: Decimal;

    if (spikeRatio.greaterThan(this.SPIKE_THRESHOLD)) {
      // Volatility spike detected → trust fast signal more
      // Market just got volatile, widen range quickly
      blended = vol1d.mul(0.8).add(vol3d.mul(0.2));
    } else if (spikeRatio.lessThan(this.DROP_THRESHOLD)) {
      // Volatility drop detected → be cautious
      // Market calmed down, but 3d remembers the volatility
      // Don't narrow range too aggressively
      blended = vol1d.mul(0.4).add(vol3d.mul(0.6));
    } else {
      // Normal regime → balanced blend
      blended = vol1d.mul(0.6).add(vol3d.mul(0.4));
    }

    // Apply floor protection
    // Never go below max(1d, 3d) * FLOOR_FACTOR
    // This prevents the blend from underestimating volatility
    const maxVol = Decimal.max(vol1d, vol3d);
    const floor = maxVol.mul(this.FLOOR_FACTOR);

    return Decimal.max(blended, floor);
  }

  /**
   * Annualize volatility to 24h
   *
   * Formula: vol24h = σ * sqrt(24h / timeframe)
   *
   * For 30m candles: sqrt(48) ≈ 6.93
   * For 1h candles: sqrt(24) ≈ 4.90
   */
  private annualizeTo24h(rawVol: Decimal): Decimal {
    const tfMinutes = this.parseTimeframeMinutes(this.config.volatilityTimeframe);
    const periodsIn24h = (24 * 60) / tfMinutes;

    // vol24h = σ * sqrt(periodsIn24h) * 100 (convert to percent)
    return rawVol.mul(new Decimal(periodsIn24h).sqrt()).mul(100);
  }

  /**
   * Calculate expected move for given hours
   *
   * Formula: expected_move = σ * sqrt(hours / tfHours) * 100
   */
  private calculateExpectedMove(rawVol: Decimal, hours: number): Decimal {
    const tfMinutes = this.parseTimeframeMinutes(this.config.volatilityTimeframe);
    const tfHours = tfMinutes / 60;
    const periods = hours / tfHours;

    return rawVol.mul(new Decimal(periods).sqrt()).mul(100);
  }

  /**
   * Parse timeframe string to minutes
   */
  private parseTimeframeMinutes(tf: string): number {
    const match = tf.match(/^(\d+)([mhd])$/);
    if (!match) return 30; // Default

    const value = parseInt(match[1]!, 10);
    const unit = match[2];

    switch (unit) {
      case 'm': return value;
      case 'h': return value * 60;
      case 'd': return value * 60 * 24;
      default: return 30;
    }
  }

  /**
   * Classify volatility into regime
   */
  private classifyRegime(vol24hPercent: Decimal): VolatilityRegime {
    const vol = vol24hPercent.toNumber();
    const t = this.config.thresholds;

    if (vol < t.ultraCalmMax) {
      return VolatilityRegime.ULTRA_CALM;
    } else if (vol < t.calmMax) {
      return VolatilityRegime.CALM;
    } else if (vol < t.normalMax) {
      return VolatilityRegime.NORMAL;
    } else if (vol < t.volatileMax) {
      return VolatilityRegime.VOLATILE;
    } else {
      return VolatilityRegime.CHAOS;
    }
  }

  /**
   * Get range width for regime with interpolation
   */
  private getRangeForRegime(regime: VolatilityRegime, vol24h: Decimal): Decimal {
    const ranges = this.config.regimeRanges[regime];
    const t = this.config.thresholds;
    const vol = vol24h.toNumber();

    // Get regime boundaries for interpolation
    let lowerBound: number;
    let upperBound: number;

    switch (regime) {
      case VolatilityRegime.ULTRA_CALM:
        lowerBound = 0;
        upperBound = t.ultraCalmMax;
        break;
      case VolatilityRegime.CALM:
        lowerBound = t.ultraCalmMax;
        upperBound = t.calmMax;
        break;
      case VolatilityRegime.NORMAL:
        lowerBound = t.calmMax;
        upperBound = t.normalMax;
        break;
      case VolatilityRegime.VOLATILE:
        lowerBound = t.normalMax;
        upperBound = t.volatileMax;
        break;
      case VolatilityRegime.CHAOS:
        // For chaos, use max range
        return new Decimal(ranges.max);
    }

    // Linear interpolation within regime
    const progress = Math.max(0, Math.min(1, (vol - lowerBound) / (upperBound - lowerBound)));
    const interpolatedRange = ranges.min + progress * (ranges.max - ranges.min);

    return new Decimal(interpolatedRange);
  }

  /**
   * Clamp range to min/max bounds from config
   *
   * Uses LP_RANGE_MIN_PERCENT and LP_RANGE_MAX_PERCENT
   */
  private clampRange(range: Decimal): Decimal {
    const min = this.config.minRangeWidthPercent;
    const max = this.config.maxRangeWidthPercent;

    if (range.lessThan(min)) {
      this.logger.debug('Range clamped to minimum', {
        calculated: range.toFixed(1) + '%',
        clamped: min + '%',
      });
      return new Decimal(min);
    }
    if (range.greaterThan(max)) {
      this.logger.debug('Range clamped to maximum', {
        calculated: range.toFixed(1) + '%',
        clamped: max + '%',
      });
      return new Decimal(max);
    }
    return range;
  }

  /**
   * Build human-readable reason string
   */
  private buildReason(regime: VolatilityRegime, dualVol: DualWindowVolatility, range: Decimal): string {
    const regimeNames: Record<VolatilityRegime, string> = {
      [VolatilityRegime.ULTRA_CALM]: 'Ultra Calm',
      [VolatilityRegime.CALM]: 'Calm',
      [VolatilityRegime.NORMAL]: 'Normal',
      [VolatilityRegime.VOLATILE]: 'Volatile',
      [VolatilityRegime.CHAOS]: 'Chaos',
    };

    const trendIndicator = dualVol.trend === 'RISING' ? '↑' :
                           dualVol.trend === 'FALLING' ? '↓' : '→';

    return `${regimeNames[regime]} ${trendIndicator} ` +
           `(1d: ${dualVol.vol1d_24h.toFixed(1)}%, 3d: ${dualVol.vol3d_24h.toFixed(1)}%, ` +
           `eff: ${dualVol.effective.toFixed(1)}%) → ±${range.toFixed(1)}% range`;
  }

    /**
   * Convert windowDays (1 or 3) into candle limit for the configured timeframe.
   *
   * Example:
   * timeframe=30m => 48 candles/day => 1d=48, 3d=144
   * timeframe=1h  => 24 candles/day => 1d=24, 3d=72
   */
  private getCandleLimitForWindowDays(windowDays: 1 | 3): number {
    const tf = this.config.volatilityTimeframe;

    // reuse existing parser - YES, timeframe is needed because sigma is "per bar"
    const tfMinutes = this.parseTimeframeMinutes(tf);
    const candlesPerDay = Math.round((24 * 60) / tfMinutes);

    const limit = candlesPerDay * windowDays;

    // Safety: keep at least 10 returns
    return Math.max(limit, 12);
  }
}
