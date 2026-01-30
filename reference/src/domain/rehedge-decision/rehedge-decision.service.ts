import { injectable, inject } from 'tsyringe';
import Decimal from 'decimal.js';

import { Logger, ILogger } from '../../infra/logger/logger';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import type { IStateStore } from '../state-store';
import type { IDynamicThresholdService } from '../dynamic-threshold';
import { IRehedgeDecisionService } from './rehedge-decision.interface';
import {
  RehedgeDecisionInput,
  RehedgeDecisionResult,
  RehedgeDecisionConfig,
  ZonePosition,
  RehedgeMode,
  HysteresisState,
  DEFAULT_REHEDGE_DECISION_CONFIG,
} from './rehedge-decision.types';

/**
 * Rehedge Decision Service
 *
 * Implements triple-trigger logic with HYSTERESIS for rehedge decisions:
 * 1. Hedge Gap Safety (priority 1) - force rehedge when hedge drifted from target
 * 2. LP Delta Drift (priority 2) - rehedge when accumulated drift exceeds threshold
 * 3. Zone-based protection (modifier) - more aggressive hedging near LP boundaries
 * 4. Hysteresis (anti-churn) - two thresholds to prevent oscillation
 *
 * HEDGE GAP SAFETY (Priority 1):
 * - HARD gap (≥12%): Force immediate rehedge (ignores drift/hysteresis/cooldown)
 * - SOFT gap (≥7%): Trigger rehedge but respect cooldown
 * - Catches cases where hedge drifted due to reset/partial fills/anchor updates
 *
 * HYSTERESIS LOGIC (Priority 2):
 * - STABLE state: trigger rehedge only when drift > ENTER_THRESHOLD (higher)
 * - ADJUSTED state: ignore rehedge until drift < EXIT_THRESHOLD (lower)
 * - This prevents churn when drift hovers around threshold
 *
 * Example with hysteresisFactor=1.3, baseThreshold=5%:
 * - ENTER_THRESHOLD = 6.5%
 * - EXIT_THRESHOLD = 5.0%
 * - Without hysteresis: 5.1→rehedge, 4.9→no, 5.2→rehedge (churn!)
 * - With hysteresis: 5.1→ignore, 6.6→rehedge, 6.1→ignore, 4.9→exit (1 rehedge)
 *
 * METRICS:
 * - LP Delta Drift = |EMA(currentWeth) - anchor| / anchor
 *   PRIMARY trigger for normal rehedge decisions
 *
 * - Hedge Gap = |currentShort - targetShort| / targetShort
 *   SAFETY trigger to prevent large delta exposure
 *
 * Zone layout:
 * |------|------|------|
 *    L       M       U
 *
 * - L (Lower): Near lower boundary → protective mode (threshold × 0.5)
 * - M (Middle): Center of range → normal mode (full threshold)
 * - U (Upper): Near upper boundary → protective mode (threshold × 0.5)
 */
@injectable()
export class RehedgeDecisionService implements IRehedgeDecisionService {
  private readonly logger: ILogger;
  private readonly config: RehedgeDecisionConfig;

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE)
    private readonly configService: ConfigService,
    @inject(TOKENS.STATE_STORE) private readonly stateStore: IStateStore,
    @inject(TOKENS.DYNAMIC_THRESHOLD_SERVICE)
    private readonly dynamicThresholdService: IDynamicThresholdService,
  ) {
    this.logger = logger.child('RehedgeDecision');
    this.config = this.initializeConfig();

    this.logger.info('RehedgeDecisionService initialized', {
      minRehedgeAmountUsdc: this.config.minRehedgeAmountUsdc.toFixed(0),
      boundaryZoneWidth: `${(this.config.boundaryZoneWidth * 100).toFixed(0)}%`,
      protectiveMultiplier: this.config.protectiveThresholdMultiplier,
      hysteresisFactor: this.config.hysteresisFactor,
      emaWindowMinutes: this.config.emaWindowMinutes,
      hedgeGapSoft: `${(this.config.hedgeGapSoft * 100).toFixed(0)}%`,
      hedgeGapHard: `${(this.config.hedgeGapHard * 100).toFixed(0)}%`,
    });
  }

  /**
   * Evaluate whether rehedge should be executed
   *
   * Implements hysteresis logic:
   * - STABLE state: trigger rehedge when drift > ENTER_THRESHOLD (higher)
   * - ADJUSTED state: ignore rehedge until drift < EXIT_THRESHOLD (lower)
   *
   * This prevents oscillation (churn) when drift hovers around threshold.
   *
   * Uses EMA smoothing for drift calculation:
   * - drift = |EMA(currentWeth) - anchor| / anchor
   * - EMA filters out noise from instant LP delta changes
   * - Anchor updates ONLY on: boundary zone entry, rehedge execution, LP reset
   */
  evaluate(input: RehedgeDecisionInput): RehedgeDecisionResult {
    const {
      currentWethAmount,
      referencePrice,
      spotPrice,
      priceLower,
      priceUpper,
    } = input;

    // Store input for logging
    this.lastInput = input;

    // Get reference WETH from last hedge
    const wethAtLastHedge = this.getWethAtLastHedge();

    // Get current hysteresis state
    const hysteresisState = this.stateStore.getHysteresisState();

    // Log evaluation start
    this.logger.info('RehedgeDecisionService.evaluate() called', {
      currentWeth: currentWethAmount.toFixed(6),
      referencePrice: referencePrice.toFixed(2),
      spotPrice: spotPrice.toFixed(2),
      hasWethReference: !!wethAtLastHedge,
      wethAtLastHedge: wethAtLastHedge?.toFixed(6) || 'none',
      hysteresisState,
    });

    // Handle first hedge case
    if (!wethAtLastHedge) {
      return this.handleFirstHedge(input, hysteresisState);
    }

    // Calculate zone position and distance to boundary
    const zone = this.getZonePosition(spotPrice, priceLower, priceUpper);
    const distanceToBoundary = this.getDistanceToBoundary(
      spotPrice,
      priceLower,
      priceUpper,
    );

    // Update EMA with current WETH amount (smooths out noise)
    const emaWeth = this.updateEma(currentWethAmount);

    // Get anchor (reference point for drift calculation)
    // Priority: lpDeltaAnchor > wethAtLastHedge
    let anchor = this.getAnchor(wethAtLastHedge);

    // Detect boundary zone entry and set anchor if needed
    const inBoundaryZone = zone === 'lower' || zone === 'upper';
    const wasInBoundary = this.wasInBoundaryZone();

    if (inBoundaryZone && !wasInBoundary) {
      // Just entered boundary zone - set anchor to current EMA
      anchor = emaWeth;
      this.stateStore
        .setLpDeltaAnchor(emaWeth.toString(), 'boundary_zone_entry')
        .catch((err) => {
          this.logger.error('Failed to set anchor on boundary entry', err);
        });
      this.logger.info('Anchor set on boundary zone entry', {
        zone,
        anchor: anchor.toFixed(6),
      });
    }

    // If no anchor set yet, use wethAtLastHedge as fallback
    if (!anchor) {
      anchor = wethAtLastHedge;
    }

    // Calculate delta drift using EMA and anchor
    const wethDrift = emaWeth.sub(anchor);
    const wethDriftAbs = wethDrift.abs();
    const deltaDriftPercent = anchor.gt(0)
      ? wethDriftAbs.div(anchor)
      : new Decimal(0);
    const driftUsdc = wethDriftAbs.mul(referencePrice);

    // Calculate hedge gap (safety trigger)
    // CRITICAL: In middle zone, use EMA-based target to preserve smoothing
    // In boundary zones, use instant target for faster reaction
    const { currentShortUsdc, targetShortUsdc } = input;
    const hedgeRatio = new Decimal(
      this.configService.strategy?.hedgeRatio ?? 0.93,
    );

    // EMA-based target: emaWeth * price * hedgeRatio
    const targetShortEma = emaWeth.mul(referencePrice).mul(hedgeRatio);

    // Select target for gap calculation based on zone
    // - Middle zone: use EMA target (preserves smoothing, prevents churn)
    // - Boundary zones: use instant target (faster reaction when needed)
    const targetForGap = zone === 'middle' ? targetShortEma : targetShortUsdc;

    // Store for logging
    this.lastTargetShortEma = targetShortEma;
    this.lastTargetForGap = targetForGap;

    const hedgeGapAbs = currentShortUsdc.sub(targetForGap).abs();

    // Handle edge case: if target is 0 but we have a hedge, treat as 100% gap
    // This ensures we can close orphaned hedges via gap trigger
    let hedgeGapPercent: Decimal;
    if (targetForGap.lte(0)) {
      // If target is 0 and we have significant hedge (>$100), treat as 100% gap
      hedgeGapPercent = currentShortUsdc.gt(100)
        ? new Decimal(1)
        : new Decimal(0);
    } else {
      hedgeGapPercent = hedgeGapAbs.div(targetForGap);
    }

    // Determine hedge gap trigger level
    let hedgeGapTrigger: 'none' | 'soft' | 'hard' = 'none';
    if (hedgeGapPercent.gte(this.config.hedgeGapHard)) {
      hedgeGapTrigger = 'hard';
    } else if (hedgeGapPercent.gte(this.config.hedgeGapSoft)) {
      hedgeGapTrigger = 'soft';
    }

    // Get base threshold (dynamic or static)
    const baseThreshold = this.getBaseThreshold();

    // Apply zone-based threshold adjustment
    const thresholdMultiplier = this.getThresholdMultiplier(
      zone,
      distanceToBoundary,
    );

    // Calculate hysteresis thresholds
    // EXIT_THRESHOLD = baseThreshold * zoneMultiplier
    // ENTER_THRESHOLD = EXIT_THRESHOLD * hysteresisFactor
    const exitThreshold = baseThreshold.mul(thresholdMultiplier);
    const enterThreshold = exitThreshold.mul(this.config.hysteresisFactor);

    // Effective threshold depends on hysteresis state
    const effectiveThreshold =
      hysteresisState === 'STABLE' ? enterThreshold : exitThreshold;

    // Check conditions based on hysteresis state and hedge gap
    let shouldRehedge = false;
    let newHysteresisState: HysteresisState = hysteresisState;
    let mode: RehedgeMode = 'none';

    // Priority 1: HARD hedge gap (ignores everything else)
    if (hedgeGapTrigger === 'hard') {
      shouldRehedge = true;
      mode = 'gap_hard';
      newHysteresisState = 'ADJUSTED'; // Reset hysteresis after gap rehedge
      this.logger.warn('HARD hedge gap detected - forcing rehedge', {
        hedgeGapPercent: hedgeGapPercent.mul(100).toFixed(2) + '%',
        hardThreshold: (this.config.hedgeGapHard * 100).toFixed(2) + '%',
        currentShort: currentShortUsdc.toFixed(2),
        targetShort: targetShortUsdc.toFixed(2),
      });
    }
    // Priority 2: SOFT hedge gap (respects cooldown but overrides drift/hysteresis)
    else if (hedgeGapTrigger === 'soft') {
      shouldRehedge = true;
      mode = 'gap_soft';
      newHysteresisState = 'ADJUSTED';
      this.logger.info('SOFT hedge gap detected - triggering rehedge', {
        hedgeGapPercent: hedgeGapPercent.mul(100).toFixed(2) + '%',
        softThreshold: (this.config.hedgeGapSoft * 100).toFixed(2) + '%',
      });
    }
    // Priority 3: Normal drift-based logic with hysteresis
    else if (hysteresisState === 'STABLE') {
      // In STABLE: trigger rehedge only if drift exceeds ENTER threshold
      if (deltaDriftPercent.gt(enterThreshold)) {
        shouldRehedge = true;
        mode = thresholdMultiplier.lt(1) ? 'protective' : 'normal';
        newHysteresisState = 'ADJUSTED';
      }
    } else {
      // In ADJUSTED: check if drift fell below EXIT threshold
      if (deltaDriftPercent.lt(exitThreshold)) {
        // Drift "discharged" - return to STABLE
        newHysteresisState = 'STABLE';
        // Don't rehedge, just transition state
      }
      // If drift is between EXIT and ENTER, stay in ADJUSTED and ignore
    }

    // Check minimum notional
    // For gap triggers, check hedge gap notional instead of drift notional
    let notionalToCheck = driftUsdc;
    if (mode === 'gap_hard' || mode === 'gap_soft') {
      notionalToCheck = hedgeGapAbs;
    }

    const minNotionalMet = notionalToCheck.gte(
      this.config.minRehedgeAmountUsdc,
    );
    if (shouldRehedge && !minNotionalMet && mode !== 'gap_hard') {
      // Don't skip on HARD gap trigger (it's a safety override)
      shouldRehedge = false;
      mode = 'none';
    }

    // Determine direction based on mode
    let direction: 'increase' | 'decrease' | 'none' = 'none';
    if (shouldRehedge) {
      if (mode === 'gap_hard' || mode === 'gap_soft') {
        // For gap triggers, direction is based on hedge gap
        direction = currentShortUsdc.lt(targetShortUsdc)
          ? 'increase'
          : 'decrease';
      } else {
        // For drift triggers, direction is based on LP delta drift
        direction = wethDrift.isPositive()
          ? 'increase'
          : wethDrift.isNegative()
            ? 'decrease'
            : 'none';
      }
    }

    // Build skip reason if not rehedging
    let skipReason: string | undefined;
    if (!shouldRehedge) {
      if (hedgeGapTrigger !== 'none') {
        skipReason = `hedge gap ${hedgeGapPercent.mul(100).toFixed(2)}% (${hedgeGapTrigger}) but minNotional not met`;
      } else if (
        hysteresisState === 'ADJUSTED' &&
        deltaDriftPercent.gte(exitThreshold)
      ) {
        skipReason = `hysteresis ADJUSTED: drift ${deltaDriftPercent.mul(100).toFixed(2)}% >= exit ${exitThreshold.mul(100).toFixed(2)}% (waiting for discharge)`;
      } else if (
        hysteresisState === 'STABLE' &&
        deltaDriftPercent.lte(enterThreshold)
      ) {
        skipReason = `drift ${deltaDriftPercent.mul(100).toFixed(2)}% < enter ${enterThreshold.mul(100).toFixed(2)}%, gap ${hedgeGapPercent.mul(100).toFixed(2)}% < soft ${(this.config.hedgeGapSoft * 100).toFixed(2)}%`;
      } else if (!minNotionalMet) {
        skipReason = `drift ${driftUsdc.toFixed(0)} USDC < minAmount ${this.config.minRehedgeAmountUsdc.toFixed(0)}`;
      }
    }

    const result: RehedgeDecisionResult = {
      shouldRehedge,
      mode,
      zone,
      distanceToBoundary,
      deltaDrift: wethDriftAbs,
      deltaDriftPercent,
      effectiveThreshold,
      baseThreshold,
      thresholdMultiplier,
      direction: shouldRehedge ? direction : 'none',
      driftUsdc,
      minNotionalMet,
      skipReason,
      hysteresisState: newHysteresisState,
      enterThreshold,
      exitThreshold,
      hedgeGapPercent,
      hedgeGapTrigger,
    };

    this.logDecision(
      result,
      wethAtLastHedge,
      currentWethAmount,
      emaWeth,
      anchor,
      hysteresisState,
    );

    // Commit hysteresis transition ADJUSTED → STABLE (discharge)
    // This is safe to do here because it's not tied to rehedge execution.
    // It's just a state metric update when drift falls below exit threshold.
    // The STABLE → ADJUSTED transition is committed by ExecutionOrchestrator
    // AFTER successful rehedge execution (via recordRehedge).
    if (
      hysteresisState === 'ADJUSTED' &&
      newHysteresisState === 'STABLE' &&
      !shouldRehedge
    ) {
      this.stateStore.setHysteresisStable().catch((err) => {
        this.logger.error('Failed to commit hysteresis STABLE transition', err);
      });
      this.logger.info('Hysteresis discharged: ADJUSTED → STABLE', {
        driftPercent: deltaDriftPercent.mul(100).toFixed(2) + '%',
        exitThreshold: exitThreshold.mul(100).toFixed(2) + '%',
      });
    }

    // Save current zone for next iteration's boundary entry detection
    this.stateStore.setLastDecisionZone(zone);

    return result;
  }

  /**
   * Handle first hedge case (no reference point)
   */
  private handleFirstHedge(
    input: RehedgeDecisionInput,
    hysteresisState: HysteresisState,
  ): RehedgeDecisionResult {
    const {
      currentWethAmount,
      currentShortUsdc,
      targetShortUsdc,
      spotPrice,
      priceLower,
      priceUpper,
      referencePrice,
    } = input;

    const hasLpExposure = currentWethAmount.gt(0.01);
    const hasHedge = currentShortUsdc.gt(100);
    const zone = this.getZonePosition(spotPrice, priceLower, priceUpper);
    const distanceToBoundary = this.getDistanceToBoundary(
      spotPrice,
      priceLower,
      priceUpper,
    );

    const baseThreshold = this.getBaseThreshold();
    const thresholdMultiplier = this.getThresholdMultiplier(
      zone,
      distanceToBoundary,
    );
    const exitThreshold = baseThreshold.mul(thresholdMultiplier);
    const enterThreshold = exitThreshold.mul(this.config.hysteresisFactor);

    // Calculate hedge gap even for first hedge
    const hedgeGapAbs = currentShortUsdc.sub(targetShortUsdc).abs();
    const hedgeGapPercent = targetShortUsdc.gt(0)
      ? hedgeGapAbs.div(targetShortUsdc)
      : new Decimal(0);
    let hedgeGapTrigger: 'none' | 'soft' | 'hard' = 'none';
    if (hedgeGapPercent.gte(this.config.hedgeGapHard)) {
      hedgeGapTrigger = 'hard';
    } else if (hedgeGapPercent.gte(this.config.hedgeGapSoft)) {
      hedgeGapTrigger = 'soft';
    }

    // First hedge: rehedge if we have LP exposure but no/minimal hedge
    if (hasLpExposure && !hasHedge) {
      this.logger.info('First rehedge: LP exposure without hedge', {
        currentWeth: currentWethAmount.toFixed(6),
        currentShort: currentShortUsdc.toFixed(2),
        targetShort: targetShortUsdc.toFixed(2),
        zone,
        baseThreshold: baseThreshold.mul(100).toFixed(2) + '%',
        enterThreshold: enterThreshold.mul(100).toFixed(2) + '%',
      });

      return {
        shouldRehedge: true,
        mode: 'normal',
        zone,
        distanceToBoundary,
        deltaDrift: currentWethAmount,
        deltaDriftPercent: new Decimal(1), // 100% - first hedge
        effectiveThreshold: enterThreshold, // Use real threshold, not 0
        baseThreshold,
        thresholdMultiplier,
        direction: 'increase',
        driftUsdc: currentWethAmount.mul(referencePrice),
        minNotionalMet: true,
        hysteresisState: 'ADJUSTED', // After first hedge, go to ADJUSTED
        enterThreshold,
        exitThreshold,
        hedgeGapPercent,
        hedgeGapTrigger,
      };
    }

    // No reference and already hedged - skip until we have a reference point
    this.logger.debug('No wethAtLastHedge reference, skipping rehedge check');

    return {
      shouldRehedge: false,
      mode: 'none',
      zone,
      distanceToBoundary,
      deltaDrift: new Decimal(0),
      deltaDriftPercent: new Decimal(0),
      effectiveThreshold: enterThreshold, // Use real threshold
      baseThreshold,
      thresholdMultiplier,
      direction: 'none',
      driftUsdc: new Decimal(0),
      minNotionalMet: false,
      skipReason: 'no reference point (first hedge pending)',
      hysteresisState,
      enterThreshold,
      exitThreshold,
      hedgeGapPercent,
      hedgeGapTrigger,
    };
  }

  /**
   * Calculate zone position within LP range
   */
  getZonePosition(
    spotPrice: Decimal,
    priceLower: Decimal,
    priceUpper: Decimal,
  ): ZonePosition {
    const rangeWidth = priceUpper.sub(priceLower);
    if (rangeWidth.lte(0)) return 'middle';

    const positionInRange = spotPrice.sub(priceLower).div(rangeWidth);
    const boundaryWidth = this.config.boundaryZoneWidth;

    if (positionInRange.lt(boundaryWidth)) {
      return 'lower';
    } else if (positionInRange.gt(1 - boundaryWidth)) {
      return 'upper';
    } else {
      return 'middle';
    }
  }

  /**
   * Calculate distance to nearest boundary as fraction
   */
  getDistanceToBoundary(
    spotPrice: Decimal,
    priceLower: Decimal,
    priceUpper: Decimal,
  ): Decimal {
    const rangeWidth = priceUpper.sub(priceLower);
    if (rangeWidth.lte(0)) return new Decimal(0);

    const distanceToLower = spotPrice.sub(priceLower);
    const distanceToUpper = priceUpper.sub(spotPrice);
    const minDistance = Decimal.min(distanceToLower, distanceToUpper);

    return minDistance.div(rangeWidth);
  }

  /**
   * Get threshold multiplier based on zone position
   *
   * In protective zones (near boundary):
   * - Use lower threshold for more aggressive hedging
   * - Gradual transition based on distance to boundary
   */
  getThresholdMultiplier(
    zone: ZonePosition,
    distanceToBoundary: Decimal,
  ): Decimal {
    if (zone === 'middle') {
      return new Decimal(1); // Full threshold in middle zone
    }

    // In boundary zones, interpolate between protective and normal
    const boundaryWidth = new Decimal(this.config.boundaryZoneWidth);
    const protectiveMultiplier = new Decimal(
      this.config.protectiveThresholdMultiplier,
    );

    // Linear interpolation: at edge → protective, at boundary edge → normal
    // distanceToBoundary goes from 0 (at edge) to boundaryWidth (at middle)
    const tRaw = distanceToBoundary.div(boundaryWidth);
    const t = Decimal.max(0, Decimal.min(1, tRaw));

    // Interpolate: protective at t=0, normal (1.0) at t=1
    const multiplier = protectiveMultiplier.add(
      new Decimal(1).sub(protectiveMultiplier).mul(t),
    );

    return multiplier;
  }

  /**
   * Get WETH amount at last hedge
   */
  getWethAtLastHedge(): Decimal | null {
    const wethStr = this.stateStore.getWethAtLastHedge();
    if (!wethStr) return null;
    try {
      return new Decimal(wethStr);
    } catch {
      return null;
    }
  }

  /**
   * Check if this is the first hedge
   */
  isFirstHedge(): boolean {
    return this.getWethAtLastHedge() === null;
  }

  /**
   * Get base threshold (dynamic or static)
   */
  private getBaseThreshold(): Decimal {
    try {
      return this.dynamicThresholdService.getThreshold();
    } catch {
      return this.config.staticThreshold;
    }
  }

  /**
   * Update EMA with current LP WETH amount
   * Formula: EMA_new = alpha * value + (1 - alpha) * EMA_old
   * where alpha = 2 / (N + 1), N = window in samples
   *
   * @param currentWeth - Current LP WETH amount
   * @returns Updated EMA value
   */
  private updateEma(currentWeth: Decimal): Decimal {
    const emaStr = this.stateStore.getLpDeltaEma();
    const lastUpdateAt = this.stateStore.getLpDeltaEmaUpdatedAt();
    const now = Date.now();

    // Time-based EMA: alpha = 1 - exp(-dt / tau)
    // where tau = emaWindowMinutes * 60 * 1000 (in ms)
    // This ensures EMA behaves consistently regardless of sampling frequency
    const tauMs = this.config.emaWindowMinutes * 60 * 1000;

    let newEma: Decimal;

    if (!emaStr || !lastUpdateAt) {
      // Initialize EMA with current value
      newEma = currentWeth;
    } else {
      // Calculate time-based alpha
      const dtMs = now - lastUpdateAt;
      // Clamp dt to reasonable range (1 sec to 10 min) to avoid extreme alpha values
      const dtClamped = Math.max(1000, Math.min(dtMs, 10 * 60 * 1000));
      const alpha = 1 - Math.exp(-dtClamped / tauMs);

      // Update EMA: EMA_new = alpha * value + (1 - alpha) * EMA_old
      const oldEma = new Decimal(emaStr);
      newEma = currentWeth.mul(alpha).add(oldEma.mul(1 - alpha));

      this.logger.debug('EMA update', {
        dtMs,
        dtClamped,
        alpha: alpha.toFixed(4),
        tauMs,
        oldEma: oldEma.toFixed(6),
        currentWeth: currentWeth.toFixed(6),
        newEma: newEma.toFixed(6),
      });
    }

    // Save EMA (fire-and-forget)
    this.stateStore.updateLpDeltaEma(newEma.toString()).catch((err) => {
      this.logger.error('Failed to update LP delta EMA', err);
    });

    return newEma;
  }

  /**
   * Get anchor for drift calculation
   * Priority: lpDeltaAnchor > wethAtLastHedge
   *
   * @param wethAtLastHedge - Fallback value if anchor not set
   * @returns Anchor value or null
   */
  private getAnchor(wethAtLastHedge: Decimal | null): Decimal | null {
    const anchorStr = this.stateStore.getLpDeltaAnchor();

    if (anchorStr) {
      try {
        return new Decimal(anchorStr);
      } catch {
        this.logger.warn(
          'Invalid anchor value, falling back to wethAtLastHedge',
        );
      }
    }

    return wethAtLastHedge;
  }

  /**
   * Check if we were in boundary zone on last evaluation
   * Used to detect zone entry (middle → lower/upper transition)
   */
  private wasInBoundaryZone(): boolean {
    const lastZone = this.stateStore.getLastDecisionZone();
    // If no previous zone recorded, assume we were in middle (safe default)
    if (!lastZone) return false;
    return lastZone === 'lower' || lastZone === 'upper';
  }

  /**
   * Log the decision with context
   */
  private logDecision(
    result: RehedgeDecisionResult,
    wethAtLastHedge: Decimal,
    currentWeth: Decimal,
    emaWeth: Decimal,
    anchor: Decimal,
    previousHysteresisState: HysteresisState,
  ): void {
    const { currentShortUsdc, targetShortUsdc } = this.lastInput!;

    const logData = {
      shouldRehedge: result.shouldRehedge,
      mode: result.mode,
      zone: result.zone,
      distanceToBoundary: result.distanceToBoundary.mul(100).toFixed(1) + '%',
      // EMA smoothing values
      currentWeth: currentWeth.toFixed(6),
      emaWeth: emaWeth.toFixed(6),
      anchor: anchor.toFixed(6),
      wethAtLastHedge: wethAtLastHedge.toFixed(6),
      // Drift calculation (using EMA)
      deltaDrift: result.deltaDrift.toFixed(6),
      driftPercent: result.deltaDriftPercent.mul(100).toFixed(2) + '%',
      driftUsdc: result.driftUsdc.toFixed(2),
      baseThreshold: result.baseThreshold.mul(100).toFixed(2) + '%',
      thresholdMultiplier: result.thresholdMultiplier.toFixed(2),
      // Hysteresis thresholds
      enterThreshold: result.enterThreshold.mul(100).toFixed(2) + '%',
      exitThreshold: result.exitThreshold.mul(100).toFixed(2) + '%',
      effectiveThreshold: result.effectiveThreshold.mul(100).toFixed(2) + '%',
      // Hysteresis state
      hysteresisStateBefore: previousHysteresisState,
      hysteresisStateAfter: result.hysteresisState,
      // Hedge gap safety
      currentShortUsdc: currentShortUsdc.toFixed(2),
      targetShortUsdc: targetShortUsdc.toFixed(2),
      targetShortEma: this.lastTargetShortEma?.toFixed(2) ?? 'N/A',
      targetForGap: this.lastTargetForGap?.toFixed(2) ?? 'N/A',
      hedgeGapPercent: result.hedgeGapPercent.mul(100).toFixed(2) + '%',
      hedgeGapTrigger: result.hedgeGapTrigger,
      hedgeGapSoft: (this.config.hedgeGapSoft * 100).toFixed(2) + '%',
      hedgeGapHard: (this.config.hedgeGapHard * 100).toFixed(2) + '%',
      direction: result.direction,
      minNotionalMet: result.minNotionalMet,
      ...(result.skipReason && { skipReason: result.skipReason }),
    };

    if (result.shouldRehedge) {
      this.logger.info('Rehedge decision: YES', logData);
    } else {
      this.logger.info('Rehedge decision: NO', logData);
    }
  }

  // Store last input for logging
  private lastInput: RehedgeDecisionInput | null = null;
  private lastTargetShortEma: Decimal | null = null;
  private lastTargetForGap: Decimal | null = null;

  /**
   * Initialize configuration
   */
  private initializeConfig(): RehedgeDecisionConfig {
    const strategy = this.configService.strategy;

    return {
      minRehedgeAmountUsdc: new Decimal(strategy?.minRehedgeAmountUsdc ?? 300),
      staticThreshold: new Decimal(strategy?.rehedgeThresholdPercent ?? 0.05),
      boundaryZoneWidth:
        strategy?.boundaryZoneWidth ??
        DEFAULT_REHEDGE_DECISION_CONFIG.boundaryZoneWidth ??
        0.15,
      protectiveThresholdMultiplier:
        strategy?.protectiveThresholdMultiplier ??
        DEFAULT_REHEDGE_DECISION_CONFIG.protectiveThresholdMultiplier ??
        0.5,
      hysteresisFactor:
        strategy?.hysteresisFactor ??
        DEFAULT_REHEDGE_DECISION_CONFIG.hysteresisFactor ??
        1.3,
      emaWindowMinutes:
        strategy?.emaWindowMinutes ??
        DEFAULT_REHEDGE_DECISION_CONFIG.emaWindowMinutes ??
        20,
      hedgeGapSoft:
        strategy?.hedgeGapSoft ??
        DEFAULT_REHEDGE_DECISION_CONFIG.hedgeGapSoft ??
        0.07,
      hedgeGapHard:
        strategy?.hedgeGapHard ??
        DEFAULT_REHEDGE_DECISION_CONFIG.hedgeGapHard ??
        0.12,
    };
  }
}
