import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { EventBus } from '../../infra/event-bus/event-bus';
import type { ILpPositionService } from '../lp-position';
import type { IHedgeService } from '../hedge';
import type { IPriceService } from '../price';
import type { IRiskManager } from '../risk';
import type { IMonitoringService } from '../monitoring';
import type { IRangeModelService, DynamicRangeResult } from '../range-model';
import type { IDynamicThresholdService } from '../dynamic-threshold';
import type {
  IRehedgeDecisionService,
  RehedgeDecisionResult,
} from '../rehedge-decision';
import type { RiskFlags } from '../risk/risk.types';
import { IStrategyEngine } from './strategy.interface';
import {
  LpCompositionInput,
  HedgeInput,
  RangeBounds,
  ActionPlan,
  ActionPlanType,
  StrategyAction,
  StrategyState,
  StrategyThresholds,
  LpMetrics,
  HedgeMetrics,
  ResetDecision,
  NewRangeBounds,
} from './strategy.types';

/**
 * Strategy Engine for ADN-CLP/hedged-LP
 * Converts inputs (price, LP, hedge, risks) into ActionPlan
 */
@injectable()
export class StrategyEngine implements IStrategyEngine {
  private readonly logger: ILogger;
  private thresholds: StrategyThresholds;
  private lastState: StrategyState | null = null;

  // Cache for dynamic range to avoid redundant calls within same tick
  private lastDynamicRange: DynamicRangeResult | null = null;
  private lastDynamicRangeAt: number = 0;
  private readonly dynamicRangeCacheTtlMs = 30_000; // 30 seconds

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE)
    private readonly configService: ConfigService,
    @inject(TOKENS.EVENT_BUS) private readonly eventBus: EventBus,
    @inject(TOKENS.LP_POSITION_SERVICE)
    private readonly lpService: ILpPositionService,
    @inject(TOKENS.HEDGE_SERVICE) private readonly hedgeService: IHedgeService,
    @inject(TOKENS.PRICE_SERVICE) private readonly priceService: IPriceService,
    @inject(TOKENS.RISK_MANAGER) private readonly riskManager: IRiskManager,
    @inject(TOKENS.MONITORING_SERVICE)
    private readonly monitoringService: IMonitoringService,
    @inject(TOKENS.RANGE_MODEL_SERVICE)
    private readonly rangeModelService: IRangeModelService,
    @inject(TOKENS.DYNAMIC_THRESHOLD_SERVICE)
    private readonly dynamicThresholdService: IDynamicThresholdService,
    @inject(TOKENS.REHEDGE_DECISION_SERVICE)
    private readonly rehedgeDecisionService: IRehedgeDecisionService,
  ) {
    this.logger = logger.child('StrategyEngine');

    this.thresholds = this.initializeThresholds();

    this.logger.info('StrategyEngine initialized', {
      hedgeRatio: this.thresholds.hedgeRatio.toString(),
      rehedgeThreshold:
        this.thresholds.rehedgeThresholdPercent.mul(100).toString() + '%',
      resetNearBoundary:
        this.thresholds.resetNearBoundaryPercent.mul(100).toString() + '%',
      rangeWidth:
        this.thresholds.rangeWidthPercent +
        '% (default, dynamic used at runtime)',
    });
  }

  /**
   * Initialize thresholds from config
   */
  private initializeThresholds(): StrategyThresholds {
    const { strategy, lpRange, margin, pool } = this.configService;

    // Determine tick spacing based on fee tier
    // 500 (0.05%) -> 10, 3000 (0.3%) -> 60, 10000 (1%) -> 200
    const tickSpacingMap: Record<number, number> = {
      100: 1,
      500: 10,
      3000: 60,
      10000: 200,
    };
    const tickSpacing = tickSpacingMap[pool.feeTier] || 10;

    return {
      hedgeRatio: new Decimal(strategy?.hedgeRatio ?? 0.8),
      rehedgeThresholdPercent: new Decimal(
        strategy?.rehedgeThresholdPercent ?? 0.2,
      ),
      resetNearBoundaryPercent: new Decimal(
        strategy?.resetNearBoundaryPercent ?? 0.025,
      ),
      rangeWidthPercent: (lpRange?.rangeWidthPercent ?? 0.1) * 100, // fraction → percent (0.10 → 10)
      tickSpacing,
      minRehedgeAmountUsdc: new Decimal(strategy?.minRehedgeAmountUsdc ?? 300),
      minLiquidationDistancePercent: new Decimal(
        margin?.minMarginRatio ? 100 - margin.minMarginRatio * 100 : 20,
      ),
      feeCollectionThresholdUsdc: new Decimal(10),
    };
  }

  // ==================== Main Methods (per spec) ====================

  /**
   * Compute target short notional based on LP composition
   * Formula: targetShortUSDC = wethAmount * referencePrice * hedgeRatio
   */
  computeHedgeTarget(
    lpComposition: LpCompositionInput,
    referencePrice: Decimal,
  ): Decimal {
    const lpEthNotionalUsdc = lpComposition.wethAmount.mul(referencePrice);
    const targetShortUsdc = lpEthNotionalUsdc.mul(this.thresholds.hedgeRatio);

    this.logger.debug('Computed hedge target', {
      wethAmount: lpComposition.wethAmount.toFixed(6),
      price: referencePrice.toFixed(2),
      lpEthNotional: lpEthNotionalUsdc.toFixed(2),
      hedgeRatio: this.thresholds.hedgeRatio.toString(),
      targetShort: targetShortUsdc.toFixed(2),
    });

    return targetShortUsdc;
  }

  /**
   * Determine if LP range should be reset
   *
   * Reset conditions (per spec):
   * 1. Out of range: referencePrice <= Pl or referencePrice >= Pu
   * 2. Near boundary:
   *    - referencePrice >= Pu * (1 - nearBoundaryPct)
   *    - referencePrice <= Pl * (1 + nearBoundaryPct)
   *
   * @returns ResetDecision with details
   */
  evaluateResetNeed(
    lpComposition: LpCompositionInput,
    referencePrice: Decimal,
  ): ResetDecision {
    const nearBoundaryPct = this.thresholds.resetNearBoundaryPercent;

    // Convert ticks to prices
    const priceLower = this.lpService.tickToPrice(lpComposition.tickLower);
    const priceUpper = this.lpService.tickToPrice(lpComposition.tickUpper);

    // Check rate limit via RiskManager
    const rateLimitStatus = this.riskManager.getResetRateLimitStatus();
    const blockedByRateLimit = !rateLimitStatus.canReset;

    // 1. Check out of range
    const isOutOfRange =
      referencePrice.lessThanOrEqualTo(priceLower) ||
      referencePrice.greaterThanOrEqualTo(priceUpper);

    if (isOutOfRange) {
      const boundaryAtRisk = referencePrice.lessThanOrEqualTo(priceLower)
        ? 'lower'
        : 'upper';
      const distancePercent =
        boundaryAtRisk === 'lower'
          ? priceLower.sub(referencePrice).div(priceLower).mul(100)
          : referencePrice.sub(priceUpper).div(priceUpper).mul(100);

      this.logger.info('Reset needed: OUT OF RANGE', {
        referencePrice: referencePrice.toFixed(2),
        priceLower: priceLower.toFixed(2),
        priceUpper: priceUpper.toFixed(2),
        boundaryAtRisk,
      });

      // Out of range = critical, rate limit doesn't block
      return {
        shouldReset: true,
        reason: `Price ${referencePrice.toFixed(2)} is out of range [${priceLower.toFixed(2)}, ${priceUpper.toFixed(2)}]`,
        isOutOfRange: true,
        boundaryAtRisk,
        distancePercent: distancePercent.abs(),
        blockedByRateLimit: false, // Rate limit doesn't block out-of-range resets
        priority: 'critical',
      };
    }

    // 2. Check near upper boundary: referencePrice >= Pu * (1 - nearBoundaryPct)
    const upperThreshold = priceUpper.mul(new Decimal(1).sub(nearBoundaryPct));
    if (referencePrice.greaterThanOrEqualTo(upperThreshold)) {
      const distancePercent = priceUpper
        .sub(referencePrice)
        .div(priceUpper)
        .mul(100);

      this.logger.info('Reset needed: near UPPER boundary', {
        referencePrice: referencePrice.toFixed(2),
        upperThreshold: upperThreshold.toFixed(2),
        priceUpper: priceUpper.toFixed(2),
        distancePercent: distancePercent.toFixed(2) + '%',
      });

      return {
        shouldReset: !blockedByRateLimit,
        reason: blockedByRateLimit
          ? `Near upper boundary but rate-limited (wait ${rateLimitStatus.secondsUntilNextAllowed.toFixed(0)}s)`
          : `Price ${referencePrice.toFixed(2)} within ${nearBoundaryPct.mul(100).toFixed(1)}% of upper bound ${priceUpper.toFixed(2)}`,
        isOutOfRange: false,
        boundaryAtRisk: 'upper',
        distancePercent,
        blockedByRateLimit,
        priority: 'medium',
      };
    }

    // 3. Check near lower boundary: referencePrice <= Pl * (1 + nearBoundaryPct)
    const lowerThreshold = priceLower.mul(new Decimal(1).add(nearBoundaryPct));
    if (referencePrice.lessThanOrEqualTo(lowerThreshold)) {
      const distancePercent = referencePrice
        .sub(priceLower)
        .div(priceLower)
        .mul(100);

      this.logger.info('Reset needed: near LOWER boundary', {
        referencePrice: referencePrice.toFixed(2),
        lowerThreshold: lowerThreshold.toFixed(2),
        priceLower: priceLower.toFixed(2),
        distancePercent: distancePercent.toFixed(2) + '%',
      });

      return {
        shouldReset: !blockedByRateLimit,
        reason: blockedByRateLimit
          ? `Near lower boundary but rate-limited (wait ${rateLimitStatus.secondsUntilNextAllowed.toFixed(0)}s)`
          : `Price ${referencePrice.toFixed(2)} within ${nearBoundaryPct.mul(100).toFixed(1)}% of lower bound ${priceLower.toFixed(2)}`,
        isOutOfRange: false,
        boundaryAtRisk: 'lower',
        distancePercent,
        blockedByRateLimit,
        priority: 'medium',
      };
    }

    // 4. No reset needed
    return {
      shouldReset: false,
      reason: 'Price is within safe range',
      isOutOfRange: false,
      boundaryAtRisk: 'none',
      distancePercent: new Decimal(0),
      blockedByRateLimit: false,
      priority: 'low',
    };
  }

  /**
   * Simple boolean check for backward compatibility
   */
  shouldResetRange(
    lpComposition: LpCompositionInput,
    referencePrice: Decimal,
  ): boolean {
    const decision = this.evaluateResetNeed(lpComposition, referencePrice);
    return decision.shouldReset;
  }

  /**
   * Determine if rehedge is needed based on LP delta drift and zone position
   *
   * Dual-trigger logic:
   * 1. LP Delta Drift (primary) - rehedge when accumulated drift exceeds threshold
   * 2. Zone-based protection (secondary) - more aggressive hedging near LP boundaries
   *
   * Delegates to RehedgeDecisionService for the actual decision logic.
   */
  shouldRehedge(
    currentShortUsdc: Decimal,
    targetShortUsdc: Decimal,
    currentWethAmount: Decimal,
    referencePrice: Decimal,
    lpComposition?: LpCompositionInput,
  ): RehedgeDecisionResult {
    this.logger.info('StrategyEngine.shouldRehedge() called', {
      currentShortUsdc: currentShortUsdc.toFixed(2),
      targetShortUsdc: targetShortUsdc.toFixed(2),
      currentWethAmount: currentWethAmount.toFixed(6),
      referencePrice: referencePrice.toFixed(2),
      hasLpComposition: !!lpComposition,
    });

    // Get LP bounds for zone calculation
    // Convert ticks to prices or use defaults
    let priceLower: Decimal;
    let priceUpper: Decimal;

    if (lpComposition) {
      // Convert ticks to prices
      priceLower = this.lpService.tickToPrice(lpComposition.tickLower);
      priceUpper = this.lpService.tickToPrice(lpComposition.tickUpper);
    } else {
      // Fallback: assume ±10% range
      priceLower = referencePrice.mul(0.9);
      priceUpper = referencePrice.mul(1.1);
    }

    const decision = this.rehedgeDecisionService.evaluate({
      currentWethAmount,
      currentShortUsdc,
      targetShortUsdc,
      referencePrice,
      spotPrice: referencePrice,
      priceLower,
      priceUpper,
    });

    this.logger.info('StrategyEngine.shouldRehedge() result', {
      shouldRehedge: decision.shouldRehedge,
      zone: decision.zone,
      mode: decision.mode,
      direction: decision.direction,
    });

    return decision;
  }

  /**
   * Build action plan based on all inputs
   * Priority order:
   * 1. EMERGENCY_EXIT if riskFlags.emergency
   * 2. RESET_RANGE if shouldResetRange and canExecuteReset
   * 3. REHEDGE if shouldRehedge and canExecuteRehedge
   * 4. NONE otherwise
   */
  async buildPlan(
    riskFlags: RiskFlags,
    lpComposition: LpCompositionInput,
    hedge: HedgeInput,
    referencePrice: Decimal,
    tokenId: string,
  ): Promise<ActionPlan> {
    const timestamp = Date.now();
    const actions: StrategyAction[] = [];

    this.logger.info('Building action plan', {
      emergency: riskFlags.emergency,
      inRange: lpComposition.inRange,
      hasHedge: hedge.hasPosition,
    });

    // Step 1: Check for emergency
    if (riskFlags.emergency) {
      this.logger.warn('EMERGENCY: Building emergency exit plan', {
        reasons: riskFlags.reasons,
      });

      actions.push({
        type: 'emergency_exit',
        priority: 0,
        reason: riskFlags.reasons.join('; '),
        params: {},
        isCritical: true,
      });

      const plan = this.createPlan(
        'EMERGENCY_EXIT',
        timestamp,
        referencePrice,
        actions,
        lpComposition,
        hedge,
        true,
      );
      plan.emergencyReasons = riskFlags.reasons;
      return plan;
    }

    // Step 2: Check if range reset is needed
    const resetDecision = this.evaluateResetNeed(lpComposition, referencePrice);
    const canReset = this.riskManager.canExecuteReset(riskFlags);

    if (resetDecision.shouldReset && canReset) {
      const newRange = await this.computeNewRangeWithValidation(referencePrice);

      if (!newRange.isValid) {
        this.logger.error(
          'Cannot reset: invalid new range computed',
          undefined,
          {
            tickLower: newRange.tickLower,
            tickUpper: newRange.tickUpper,
            reason: newRange.invalidReason,
          },
        );

        await this.monitoringService.alertWarn(
          'Reset blocked: invalid range computed',
          {
            component: 'StrategyEngine',
            reason: newRange.invalidReason,
            tickLower: newRange.tickLower,
            tickUpper: newRange.tickUpper,
          },
        );
      } else {
        actions.push({
          type: 'reset_range',
          priority: 1,
          reason: resetDecision.reason,
          params: {
            oldTokenId: tokenId,
            newTickLower: newRange.tickLower,
            newTickUpper: newRange.tickUpper,
          },
          isCritical: resetDecision.isOutOfRange,
        });

        // Record reset with RiskManager for rate limiting
        // (ExecutionOrchestrator should call riskManager.recordReset() on successful execution)

        const plan = this.createPlan(
          'RESET_RANGE',
          timestamp,
          referencePrice,
          actions,
          lpComposition,
          hedge,
          resetDecision.isOutOfRange,
        );
        plan.resetRangeParams = {
          oldTokenId: tokenId,
          newTickLower: newRange.tickLower,
          newTickUpper: newRange.tickUpper,
          priceLower: newRange.priceLower,
          priceUpper: newRange.priceUpper,
          reason: resetDecision.reason,
          isOutOfRange: resetDecision.isOutOfRange,
        };

        return plan;
      }
    } else if (resetDecision.shouldReset && !canReset) {
      this.logger.warn('Reset needed but blocked by risk checks', {
        resetReason: resetDecision.reason,
        riskBlocked: !canReset,
        rateBlocked: resetDecision.blockedByRateLimit,
      });
    }

    // Step 3: Check rehedge based on LP delta drift + zone-based protection
    const targetShortUsdc = this.computeHedgeTarget(
      lpComposition,
      referencePrice,
    );
    const currentShortUsdc = hedge.shortNotionalUsdc;
    const rehedgeDecision = this.shouldRehedge(
      currentShortUsdc,
      targetShortUsdc,
      lpComposition.wethAmount,
      referencePrice,
      lpComposition,
    );

    // Gap trigger bypass logic:
    // - gap_hard: bypass BOTH cooldown AND price anomaly (safety override - must execute)
    // - gap_soft: NO bypass - respects both cooldown and price anomaly
    //   Uses longer cooldown (softGapRehedgeIntervalSec) to prevent churn
    // - normal/protective: no bypass (respect all risk checks)
    const isGapHard = rehedgeDecision.mode === 'gap_hard';
    const bypassCooldown = isGapHard; // Only HARD gap bypasses cooldown
    const bypassPriceAnomaly = isGapHard; // Only HARD gap bypasses price anomaly
    const canRehedge = this.riskManager.canExecuteRehedge(
      riskFlags,
      bypassCooldown,
      bypassPriceAnomaly,
      rehedgeDecision.mode, // Pass mode for cooldown selection
    );

    this.logger.info('buildPlan: rehedge decision evaluated', {
      shouldRehedge: rehedgeDecision.shouldRehedge,
      canRehedge,
      zone: rehedgeDecision.zone,
      mode: rehedgeDecision.mode,
      driftPercent: rehedgeDecision.deltaDriftPercent.mul(100).toFixed(2) + '%',
      effectiveThreshold:
        rehedgeDecision.effectiveThreshold.mul(100).toFixed(2) + '%',
      hedgeGapPercent:
        rehedgeDecision.hedgeGapPercent.mul(100).toFixed(2) + '%',
      hedgeGapTrigger: rehedgeDecision.hedgeGapTrigger,
      direction: rehedgeDecision.direction,
    });

    if (rehedgeDecision.shouldRehedge && canRehedge) {
      const delta = targetShortUsdc.sub(currentShortUsdc);
      const direction = rehedgeDecision.direction as 'increase' | 'decrease';

      // Build reason based on trigger type
      let reason: string;
      let isCritical: boolean;

      if (
        rehedgeDecision.mode === 'gap_hard' ||
        rehedgeDecision.mode === 'gap_soft'
      ) {
        // Gap trigger - show hedge gap info
        const gapLabel =
          rehedgeDecision.mode === 'gap_hard' ? '🚨 HARD GAP' : '⚠️ Soft gap';
        reason = `${gapLabel} rehedge: hedge gap ${rehedgeDecision.hedgeGapPercent.mul(100).toFixed(1)}% (${rehedgeDecision.hedgeGapTrigger} trigger)`;
        // HARD gap is always critical (safety override)
        isCritical = rehedgeDecision.mode === 'gap_hard';
      } else {
        // Drift trigger - show drift info
        const modeLabel =
          rehedgeDecision.mode === 'protective' ? '🛡️ Protective' : 'Normal';
        reason = `${modeLabel} rehedge (${rehedgeDecision.zone} zone): drift ${rehedgeDecision.deltaDriftPercent.mul(100).toFixed(1)}% > threshold ${rehedgeDecision.effectiveThreshold.mul(100).toFixed(1)}%`;
        isCritical = rehedgeDecision.mode === 'protective';
      }

      actions.push({
        type:
          direction === 'increase' ? 'rehedge_increase' : 'rehedge_decrease',
        priority: 2,
        reason,
        params: {
          targetShortUsdc,
          deltaUsdc: delta.abs(),
          direction,
          zone: rehedgeDecision.zone,
          mode: rehedgeDecision.mode,
        },
        isCritical,
      });

      const plan = this.createPlan(
        'REHEDGE',
        timestamp,
        referencePrice,
        actions,
        lpComposition,
        hedge,
        false,
      );
      plan.rehedgeParams = {
        currentShortUsdc,
        targetShortUsdc,
        deltaUsdc: delta.abs(),
        direction,
        mode: 'makerPrefer',
        lpWethAmount: lpComposition.wethAmount,
        // Store decision metrics for event reporting
        deltaDriftPercent: rehedgeDecision.deltaDriftPercent,
        effectiveThreshold: rehedgeDecision.effectiveThreshold,
        // Store rehedge mode for cooldown tracking (gap_soft uses longer cooldown)
        rehedgeMode: rehedgeDecision.mode,
        // Human-readable reason for telegram notification
        reason,
      };

      this.logger.info('buildPlan: REHEDGE plan created', {
        zone: rehedgeDecision.zone,
        decisionMode: rehedgeDecision.mode,
        direction,
        deltaDriftPercent:
          rehedgeDecision.deltaDriftPercent.mul(100).toFixed(2) + '%',
        effectiveThreshold:
          rehedgeDecision.effectiveThreshold.mul(100).toFixed(2) + '%',
        targetShortUsdc: targetShortUsdc.toFixed(2),
        currentShortUsdc: currentShortUsdc.toFixed(2),
        deltaUsdc: delta.abs().toFixed(2),
        reason,
      });

      return plan;
    } else if (rehedgeDecision.shouldRehedge && !canRehedge) {
      // Log why rehedge was blocked (cooldown, price anomaly, etc.)
      const cooldownStatus = this.riskManager.getRehedgeCooldownStatus();
      const delta = targetShortUsdc.sub(currentShortUsdc);
      this.logger.info('Rehedge needed but blocked', {
        zone: rehedgeDecision.zone,
        mode: rehedgeDecision.mode,
        driftPercent:
          rehedgeDecision.deltaDriftPercent.mul(100).toFixed(2) + '%',
        effectiveThreshold:
          rehedgeDecision.effectiveThreshold.mul(100).toFixed(2) + '%',
        deltaUsdc: delta.abs().toFixed(2),
        cooldownActive: !cooldownStatus.canRehedge,
        secondsUntilCooldownExpires: cooldownStatus.secondsUntilNextAllowed,
        cexDown: riskFlags.cexDown,
        priceAnomaly: riskFlags.priceAnomaly,
        marginDanger: riskFlags.marginDanger,
      });
    }

    // Step 4: No action needed
    return this.createPlan(
      'NONE',
      timestamp,
      referencePrice,
      [],
      lpComposition,
      hedge,
      false,
    );
  }

  /**
   * Compute new range ticks around reference price (sync version)
   *
   * Per spec:
   * 1. Pl_new = P * (1 - w)
   * 2. Pu_new = P * (1 + w)
   * 3. Convert to ticks
   * 4. Round: tickLower = floor(tL / tickSpacing) * tickSpacing
   *           tickUpper = ceil(tU / tickSpacing) * tickSpacing
   *
   * NOTE: Uses cached dynamic range if available, otherwise falls back to config.
   * For full dynamic range, use computeNewRangeWithValidation() instead.
   */
  computeNewRange(referencePrice: Decimal): RangeBounds {
    // Use cached dynamic range if available and fresh, otherwise use config fallback
    let widthPercent: number;
    let source: string;

    const now = Date.now();
    if (
      this.lastDynamicRange &&
      now - this.lastDynamicRangeAt < this.dynamicRangeCacheTtlMs
    ) {
      widthPercent = this.lastDynamicRange.rangeWidthPercent.toNumber();
      source = 'cached-dynamic';
    } else {
      widthPercent = this.thresholds.rangeWidthPercent;
      source = 'config-fallback';
    }

    const w = new Decimal(widthPercent).div(100);
    const tickSpacing = this.thresholds.tickSpacing;

    // 1. Calculate new price bounds
    const priceLower = referencePrice.mul(new Decimal(1).sub(w));
    const priceUpper = referencePrice.mul(new Decimal(1).add(w));

    // 2. Convert to raw ticks
    const rawTickLower = this.lpService.priceToTick(priceLower);
    const rawTickUpper = this.lpService.priceToTick(priceUpper);

    // 3. Apply floor for lower, ceil for upper
    const tickLower = Math.floor(rawTickLower / tickSpacing) * tickSpacing;
    const tickUpper = Math.ceil(rawTickUpper / tickSpacing) * tickSpacing;

    this.logger.debug('Computed new range (sync)', {
      referencePrice: referencePrice.toFixed(2),
      widthPercent,
      widthSource: source,
      tickSpacing,
      tickLower,
      tickUpper,
      priceLower: priceLower.toFixed(2),
      priceUpper: priceUpper.toFixed(2),
    });

    return { tickLower, tickUpper };
  }

  /**
   * Compute new range with full validation and sanity check (async)
   * Includes pool tick sanity check
   *
   * Uses DYNAMIC range width from RangeModelService:
   * - Fetches volatility-based range from RangeModelService
   * - Falls back to LP_RANGE_WIDTH_PERCENT on error
   * - Emits error event for Telegram notification on fallback
   */
  async computeNewRangeWithValidation(
    referencePrice: Decimal,
    currentPoolTick?: number,
  ): Promise<NewRangeBounds> {
    // Get dynamic range width (or fallback)
    const { widthFraction, usedFallback, dynamicResult } =
      await this.getDynamicRangeWidthPercent();
    const w = widthFraction;
    const tickSpacing = this.thresholds.tickSpacing;

    // 1. Calculate new price bounds
    const priceLower = referencePrice.mul(new Decimal(1).sub(w));
    const priceUpper = referencePrice.mul(new Decimal(1).add(w));

    // 2. Convert to raw ticks
    const rawTickLower = this.lpService.priceToTick(priceLower);
    const rawTickUpper = this.lpService.priceToTick(priceUpper);

    // 3. Apply floor for lower, ceil for upper
    const tickLower = Math.floor(rawTickLower / tickSpacing) * tickSpacing;
    const tickUpper = Math.ceil(rawTickUpper / tickSpacing) * tickSpacing;

    // 4. Sanity check: tickLower < tickUpper
    if (tickLower >= tickUpper) {
      this.logger.error('Invalid range: tickLower >= tickUpper', undefined, {
        tickLower,
        tickUpper,
        referencePrice: referencePrice.toFixed(2),
      });

      return {
        tickLower,
        tickUpper,
        priceLower: this.lpService.tickToPrice(tickLower),
        priceUpper: this.lpService.tickToPrice(tickUpper),
        isValid: false,
        invalidReason: 'tickLower >= tickUpper after rounding',
      };
    }

    // 5. Get current pool tick for sanity check
    let poolTick = currentPoolTick;
    if (poolTick === undefined) {
      try {
        const poolState = await this.lpService.getPoolState();
        poolTick = poolState.tick;
      } catch (e) {
        this.logger.warn('Could not get pool state for sanity check', {
          error: (e as Error).message,
        });
      }
    }

    // 6. Sanity: current tick should be inside new range
    let isValid = true;
    let invalidReason: string | undefined;

    if (poolTick !== undefined) {
      if (poolTick <= tickLower || poolTick >= tickUpper) {
        isValid = false;
        invalidReason = `Current pool tick ${poolTick} is outside new range [${tickLower}, ${tickUpper}]`;

        this.logger.error('Range sanity check failed', undefined, {
          poolTick,
          tickLower,
          tickUpper,
          referencePrice: referencePrice.toFixed(2),
        });
      }
    }

    const result: NewRangeBounds = {
      tickLower,
      tickUpper,
      priceLower: this.lpService.tickToPrice(tickLower),
      priceUpper: this.lpService.tickToPrice(tickUpper),
      isValid,
      currentPoolTick: poolTick,
      invalidReason,
    };

    this.logger.info('Computed new range (validated)', {
      referencePrice: referencePrice.toFixed(2),
      widthPercent: w.mul(100).toFixed(1) + '%',
      widthSource: usedFallback ? 'FALLBACK (config)' : 'DYNAMIC (volatility)',
      regime: dynamicResult?.regime ?? 'N/A',
      volatilityTrend: dynamicResult?.volatilityTrend ?? 'N/A',
      tickSpacing,
      tickLower,
      tickUpper,
      priceLower: result.priceLower.toFixed(2),
      priceUpper: result.priceUpper.toFixed(2),
      isValid,
      currentPoolTick: poolTick,
    });

    return result;
  }

  // ==================== Helper Methods ====================

  private createPlan(
    type: ActionPlanType,
    timestamp: number,
    referencePrice: Decimal,
    actions: StrategyAction[],
    lpComposition: LpCompositionInput,
    hedge: HedgeInput,
    isCritical: boolean,
  ): ActionPlan {
    const lpMetrics: LpMetrics = {
      lpTotalUsdc: lpComposition.totalValueUsdc,
      lpEthNotionalUsdc: lpComposition.wethAmount.mul(referencePrice),
      lpEthAmount: lpComposition.wethAmount,
      lpUsdcAmount: lpComposition.usdcAmount,
      currentTick: lpComposition.currentTick,
      tickLower: lpComposition.tickLower,
      tickUpper: lpComposition.tickUpper,
      inRange: lpComposition.inRange,
      distanceToLowerPercent: lpComposition.distanceToLowerPercent,
      distanceToUpperPercent: lpComposition.distanceToUpperPercent,
      currentPrice: referencePrice,
      priceLower: this.lpService.tickToPrice(lpComposition.tickLower),
      priceUpper: this.lpService.tickToPrice(lpComposition.tickUpper),
    };

    const hedgeMetrics: HedgeMetrics = {
      shortNotionalUsdc: hedge.shortNotionalUsdc,
      shortEthAmount: hedge.shortSizeEth,
      entryPrice: new Decimal(0), // Not provided in input
      markPrice: hedge.markPrice,
      unrealizedPnl: new Decimal(0),
      leverage: 1,
      marginRatio: new Decimal(0),
      liquidationDistance: hedge.liquidationDistancePercent,
      hasPosition: hedge.hasPosition,
    };

    const summary = this.buildSummary(type, actions);

    // Update state
    this.lastState = {
      price: referencePrice,
      lpMetrics,
      hedgeMetrics,
      lastActionPlan: null, // Will be set below
      lastUpdateTimestamp: timestamp,
      isHealthy: !isCritical,
      healthIssues: isCritical ? actions.map((a) => a.reason) : [],
    };

    const plan: ActionPlan = {
      type,
      timestamp,
      referencePrice,
      actions,
      isCritical,
      summary,
      lpMetrics,
      hedgeMetrics,
    };

    this.lastState.lastActionPlan = plan;

    this.logger.info('Action plan created', {
      type,
      actionCount: actions.length,
      isCritical,
      summary,
    });

    return plan;
  }

  private buildSummary(
    type: ActionPlanType,
    actions: StrategyAction[],
  ): string {
    switch (type) {
      case 'EMERGENCY_EXIT':
        return 'EMERGENCY: Exit all positions immediately';
      case 'RESET_RANGE':
        return 'Reset LP range to new bounds around current price';
      case 'REHEDGE':
        const rehedgeAction = actions.find((a) =>
          a.type.startsWith('rehedge_'),
        );
        if (rehedgeAction) {
          return `Rehedge: ${rehedgeAction.params.direction} short by $${rehedgeAction.params.deltaUsdc?.toFixed(2) || '?'}`;
        }
        return 'Rehedge position';
      case 'NONE':
        return 'No action needed - position is healthy';
      default:
        return `Action: ${type}`;
    }
  }

  // ==================== Dynamic Range Width ====================

  /**
   * Get dynamic LP range width from RangeModelService with fallback to config
   *
   * Returns range width as a fraction (e.g., 0.10 = ±10%)
   *
   * On error:
   * - Falls back to LP_RANGE_WIDTH_PERCENT from config
   * - Emits error event for notification via Telegram
   */
  private async getDynamicRangeWidthPercent(): Promise<{
    widthFraction: Decimal;
    usedFallback: boolean;
    dynamicResult: DynamicRangeResult | null;
  }> {
    const now = Date.now();
    const fallbackWidth = new Decimal(this.thresholds.rangeWidthPercent).div(
      100,
    );

    // Check cache first
    if (
      this.lastDynamicRange &&
      now - this.lastDynamicRangeAt < this.dynamicRangeCacheTtlMs
    ) {
      return {
        widthFraction: this.lastDynamicRange.rangeWidthPercent.div(100),
        usedFallback: false,
        dynamicResult: this.lastDynamicRange,
      };
    }

    try {
      const dynamicResult =
        await this.rangeModelService.calculateDynamicRange();

      // Update cache
      this.lastDynamicRange = dynamicResult;
      this.lastDynamicRangeAt = now;

      // Log the dynamic range
      this.logger.info('Using dynamic LP range width', {
        rangeWidthPercent: dynamicResult.rangeWidthPercent.toFixed(1) + '%',
        regime: dynamicResult.regime,
        vol1d: dynamicResult.volatility1d.toFixed(2) + '%',
        vol3d: dynamicResult.volatility3d.toFixed(2) + '%',
        trend: dynamicResult.volatilityTrend,
        lpEnabled: dynamicResult.lpEnabled,
      });

      // Check if LP should be disabled (chaos mode)
      if (!dynamicResult.lpEnabled) {
        this.logger.warn(
          'RangeModelService suggests LP should be OFF due to high volatility',
          {
            regime: dynamicResult.regime,
            volatility24h: dynamicResult.volatility24h.toFixed(2) + '%',
          },
        );

        // Emit warning but still return the range - ExecutionOrchestrator should handle LP disable
        this.eventBus.emit('error', {
          source: 'StrategyEngine',
          message: 'High volatility: RangeModelService recommends LP OFF',
          severity: 'high',
          timestamp: now,
          ctx: {
            regime: dynamicResult.regime,
            volatility24h: dynamicResult.volatility24h.toFixed(2) + '%',
            suggestedRange: dynamicResult.rangeWidthPercent.toFixed(1) + '%',
          },
        });
      }

      return {
        widthFraction: dynamicResult.rangeWidthPercent.div(100),
        usedFallback: false,
        dynamicResult,
      };
    } catch (error) {
      // Log error
      this.logger.error(
        'Failed to get dynamic range, using fallback',
        error as Error,
        {
          fallbackWidth: this.thresholds.rangeWidthPercent + '%',
        },
      );

      // Emit error event for Telegram notification
      this.eventBus.emit('error', {
        source: 'StrategyEngine',
        message:
          'Dynamic range calculation failed, using fallback LP_RANGE_WIDTH_PERCENT',
        severity: 'medium',
        timestamp: now,
        error: error as Error,
        ctx: {
          fallbackWidth: this.thresholds.rangeWidthPercent + '%',
        },
      });

      return {
        widthFraction: fallbackWidth,
        usedFallback: true,
        dynamicResult: null,
      };
    }
  }

  /**
   * Get last dynamic range result (for diagnostics)
   */
  getLastDynamicRange(): DynamicRangeResult | null {
    return this.lastDynamicRange;
  }

  // ==================== Getters ====================

  getThresholds(): StrategyThresholds {
    return { ...this.thresholds };
  }

  updateThresholds(thresholds: Partial<StrategyThresholds>): void {
    this.thresholds = { ...this.thresholds, ...thresholds };
    this.logger.info('Thresholds updated', thresholds);
  }

  getLastState(): StrategyState | null {
    return this.lastState;
  }
}
