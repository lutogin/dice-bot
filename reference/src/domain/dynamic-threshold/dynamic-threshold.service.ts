import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { IDynamicThresholdService } from './dynamic-threshold.interface';
import {
  DynamicThresholdInput,
  DynamicThresholdResult,
  DynamicThresholdConfig,
  ThresholdFactors,
  DEFAULT_DYNAMIC_THRESHOLD_CONFIG,
} from './dynamic-threshold.types';

/**
 * Dynamic Threshold Service
 *
 * Calculates rehedge threshold dynamically based on:
 * 1. Size factor - larger positions get tighter thresholds
 * 2. Volatility factor - higher vol → wider threshold (avoid noise)
 * 3. Cost factor - higher costs → wider threshold
 *
 * Formula:
 *   dynamicThreshold = base * sizeFactor * volFactor * costFactor
 *   threshold = clamp(dynamicThreshold, min, max)
 *
 * Note: Boundary/zone factor is NOT included here - it's applied in RehedgeDecisionService
 * because zone position is calculated in real-time on each decision loop.
 *
 * Usage:
 *   - Call recalculate() on cron schedule (e.g., every 30 min)
 *   - Call getThreshold() to get current cached value
 */
@injectable()
export class DynamicThresholdService implements IDynamicThresholdService {
  private readonly logger: ILogger;
  private config: DynamicThresholdConfig;

  // Cached threshold result
  private cachedResult: DynamicThresholdResult | null = null;
  private lastRecalculateAt: number = 0;

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE)
    private readonly configService: ConfigService,
  ) {
    this.logger = logger.child('DynamicThresholdService');
    this.config = this.initializeConfig();

    this.logger.info('DynamicThresholdService initialized', {
      enabled: this.isEnabled(),
      baseThreshold: (this.config.baseThreshold * 100).toFixed(1) + '%',
      referenceNotional: '$' + this.config.referenceNotionalUsdc,
      referenceVol: (this.config.referenceVolatility * 100).toFixed(1) + '%',
      thresholdRange: `${(this.config.thresholdMin * 100).toFixed(1)}% - ${(this.config.thresholdMax * 100).toFixed(1)}%`,
    });
  }

  /**
   * Check if dynamic threshold is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  /**
   * Get current threshold value (cached)
   *
   * Returns the last calculated threshold, or static fallback if:
   * - Dynamic threshold is disabled
   * - No calculation has been done yet
   *
   * @returns Current threshold as decimal (e.g., 0.05 = 5%)
   */
  getThreshold(): Decimal {
    // If disabled, return static threshold from strategy config
    if (!this.isEnabled()) {
      const staticThreshold =
        this.configService.strategy?.rehedgeThresholdPercent ?? 0.04;
      return new Decimal(staticThreshold);
    }

    // If no cached result, return base threshold
    if (!this.cachedResult) {
      return new Decimal(this.config.baseThreshold);
    }

    return this.cachedResult.threshold;
  }

  /**
   * Get full cached result with all factors (for diagnostics)
   */
  getLastResult(): DynamicThresholdResult | null {
    return this.cachedResult;
  }

  /**
   * Get time since last recalculation (ms)
   */
  getTimeSinceLastRecalculate(): number {
    if (this.lastRecalculateAt === 0) {
      return Infinity;
    }
    return Date.now() - this.lastRecalculateAt;
  }

  /**
   * Recalculate threshold with new input data
   *
   * Should be called on cron schedule (e.g., every 5 min)
   *
   * @param input - Current LP notional, volatility, boundary distance
   * @returns Updated threshold result
   */
  recalculate(input: DynamicThresholdInput): DynamicThresholdResult {
    const timestamp = Date.now();
    const baseThreshold = new Decimal(this.config.baseThreshold);

    // Calculate individual factors
    const factors = this.calculateFactors(input);

    // Compute raw threshold (without boundary factor - that's applied in RehedgeDecisionService)
    const rawThreshold = baseThreshold
      .mul(factors.sizeFactor)
      .mul(factors.volFactor)
      .mul(factors.costFactor);

    // Clamp to min/max
    const thresholdMin = new Decimal(this.config.thresholdMin);
    const thresholdMax = new Decimal(this.config.thresholdMax);
    const threshold = Decimal.max(
      thresholdMin,
      Decimal.min(thresholdMax, rawThreshold),
    );
    const wasClamped = !threshold.equals(rawThreshold);

    const result: DynamicThresholdResult = {
      threshold,
      baseThreshold,
      factors,
      rawThreshold,
      wasClamped,
      timestamp,
    };

    // Cache the result
    this.cachedResult = result;
    this.lastRecalculateAt = timestamp;

    this.logger.info('Dynamic threshold recalculated', {
      threshold: (threshold.toNumber() * 100).toFixed(2) + '%',
      baseThreshold: (baseThreshold.toNumber() * 100).toFixed(2) + '%',
      rawThreshold: (rawThreshold.toNumber() * 100).toFixed(2) + '%',
      wasClamped,
      sizeFactor: factors.sizeFactor.toFixed(3),
      volFactor: factors.volFactor.toFixed(3),
      costFactor: factors.costFactor.toFixed(3),
      lpNotional: '$' + input.lpNotionalUsdc.toFixed(0),
      vol24h: (input.volatility24h.toNumber() * 100).toFixed(2) + '%',
      distanceToBoundary:
        (input.distanceToBoundaryPct.toNumber() * 100).toFixed(2) + '%',
      note: 'Zone factor applied in RehedgeDecisionService',
    });

    return result;
  }

  /**
   * Calculate threshold (without caching) - for one-off calculations
   */
  calculateThreshold(input: DynamicThresholdInput): DynamicThresholdResult {
    const timestamp = Date.now();
    const baseThreshold = new Decimal(this.config.baseThreshold);

    const factors = this.calculateFactors(input);

    const rawThreshold = baseThreshold
      .mul(factors.sizeFactor)
      .mul(factors.volFactor)
      .mul(factors.costFactor);

    const thresholdMin = new Decimal(this.config.thresholdMin);
    const thresholdMax = new Decimal(this.config.thresholdMax);
    const threshold = Decimal.max(
      thresholdMin,
      Decimal.min(thresholdMax, rawThreshold),
    );
    const wasClamped = !threshold.equals(rawThreshold);

    return {
      threshold,
      baseThreshold,
      factors,
      rawThreshold,
      wasClamped,
      timestamp,
    };
  }

  /**
   * Calculate individual factors (excluding boundary - that's in RehedgeDecisionService)
   */
  private calculateFactors(input: DynamicThresholdInput): ThresholdFactors {
    const sizeFactor = this.calculateSizeFactor(input.lpNotionalUsdc);
    const volFactor = this.calculateVolFactor(input.volatility24h);
    const costFactor = this.calculateCostFactor(input);
    const boundaryFactor = new Decimal(1); // Not used - kept for interface compatibility

    return {
      sizeFactor,
      volFactor,
      costFactor,
      boundaryFactor,
    };
  }

  /**
   * Size factor: sqrt(referenceNotional / lpNotional)
   *
   * - Small positions (< ref) → factor > 1 → higher threshold → less rehedge
   * - Large positions (> ref) → factor < 1 → lower threshold → more rehedge
   */
  private calculateSizeFactor(lpNotionalUsdc: Decimal): Decimal {
    const referenceNotional = new Decimal(this.config.referenceNotionalUsdc);

    if (lpNotionalUsdc.lte(0)) {
      return new Decimal(1);
    }

    const ratio = referenceNotional.div(lpNotionalUsdc);
    const sizeFactor = ratio.sqrt();

    // Clamp to reasonable range [0.5, 2.0]
    return Decimal.max(
      new Decimal(0.5),
      Decimal.min(new Decimal(2.0), sizeFactor),
    );
  }

  /**
   * Volatility factor: clamp(vol24h / volRef, min, max)
   *
   * - High volatility → factor > 1 → higher threshold → less rehedge (avoid noise)
   * - Low volatility → factor < 1 → lower threshold → more rehedge
   */
  private calculateVolFactor(volatility24h: Decimal): Decimal {
    const refVol = new Decimal(this.config.referenceVolatility);
    const minFactor = new Decimal(this.config.volFactorMin);
    const maxFactor = new Decimal(this.config.volFactorMax);

    if (refVol.lte(0)) {
      return new Decimal(1);
    }

    const rawFactor = volatility24h.div(refVol);

    return Decimal.max(minFactor, Decimal.min(maxFactor, rawFactor));
  }

  /**
   * Cost factor: 1 + (hedgeCost / lpDailyFees)
   *
   * - High execution cost relative to fees → higher threshold → less rehedge
   */
  private calculateCostFactor(input: DynamicThresholdInput): Decimal {
    if (!this.config.enableCostFactor) {
      return new Decimal(1);
    }

    // Guard: ensure hedgeCost is non-negative (costFactor should be >= 1)
    const hedgeCost = Decimal.max(
      new Decimal(0),
      input.estimatedHedgeCostUsdc ?? new Decimal(0),
    );
    // Use config value as fallback (not 1, which would cause huge factor)
    const dailyFees =
      input.lpDailyFeesUsdc ??
      new Decimal(this.config.lpDailyFeesEstimateUsdc || 5);

    if (dailyFees.lte(0)) {
      return new Decimal(1);
    }

    const costRatio = hedgeCost.div(dailyFees);
    const costFactor = new Decimal(1).add(costRatio);

    const maxCostFactor = new Decimal(this.config.costFactorMax);
    return Decimal.min(maxCostFactor, costFactor);
  }

  /**
   * Check if rehedge should be skipped based on current threshold
   */
  shouldSkipRehedge(currentDeviation: Decimal): boolean {
    const threshold = this.getThreshold();
    const shouldSkip = currentDeviation.lte(threshold);

    if (shouldSkip && this.cachedResult) {
      this.logger.debug('Rehedge skipped: deviation below dynamic threshold', {
        deviation: (currentDeviation.toNumber() * 100).toFixed(2) + '%',
        threshold: (threshold.toNumber() * 100).toFixed(2) + '%',
      });
    }

    return shouldSkip;
  }

  /**
   * Get current configuration
   */
  getConfig(): DynamicThresholdConfig {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<DynamicThresholdConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('DynamicThresholdService config updated', config);
  }

  /**
   * Initialize config from ConfigService
   */
  private initializeConfig(): DynamicThresholdConfig {
    const dynamicThreshold = this.configService.dynamicThreshold;

    if (!dynamicThreshold) {
      return { ...DEFAULT_DYNAMIC_THRESHOLD_CONFIG };
    }

    return {
      enabled:
        dynamicThreshold.enabled ?? DEFAULT_DYNAMIC_THRESHOLD_CONFIG.enabled,
      baseThreshold:
        dynamicThreshold.baseThreshold ??
        DEFAULT_DYNAMIC_THRESHOLD_CONFIG.baseThreshold,
      referenceNotionalUsdc:
        dynamicThreshold.referenceNotionalUsdc ??
        DEFAULT_DYNAMIC_THRESHOLD_CONFIG.referenceNotionalUsdc,
      referenceVolatility:
        dynamicThreshold.referenceVolatility ??
        DEFAULT_DYNAMIC_THRESHOLD_CONFIG.referenceVolatility,
      volFactorMin:
        dynamicThreshold.volFactorMin ??
        DEFAULT_DYNAMIC_THRESHOLD_CONFIG.volFactorMin,
      volFactorMax:
        dynamicThreshold.volFactorMax ??
        DEFAULT_DYNAMIC_THRESHOLD_CONFIG.volFactorMax,
      thresholdMin:
        dynamicThreshold.thresholdMin ??
        DEFAULT_DYNAMIC_THRESHOLD_CONFIG.thresholdMin,
      thresholdMax:
        dynamicThreshold.thresholdMax ??
        DEFAULT_DYNAMIC_THRESHOLD_CONFIG.thresholdMax,
      enableCostFactor:
        dynamicThreshold.enableCostFactor ??
        DEFAULT_DYNAMIC_THRESHOLD_CONFIG.enableCostFactor,
      costFactorMax:
        dynamicThreshold.costFactorMax ??
        DEFAULT_DYNAMIC_THRESHOLD_CONFIG.costFactorMax,
      lpDailyFeesEstimateUsdc:
        dynamicThreshold.lpDailyFeesEstimateUsdc ??
        DEFAULT_DYNAMIC_THRESHOLD_CONFIG.lpDailyFeesEstimateUsdc,
    };
  }
}
