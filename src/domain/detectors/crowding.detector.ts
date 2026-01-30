import { injectable, inject } from 'tsyringe';
import { v4 as uuidv4 } from 'uuid';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { EventBus } from '../../infra/event-bus/event-bus';
import { FeatureBuilder } from '../features/features.service';
import { Features } from '../features/features.types';
import { ForcedEvent, IDetector } from './detector.types';
import {
  setupEventHandlers,
  EventHandler,
} from '../../infra/event-bus/event-bus.decorators';

/**
 * CrowdingDetector detects OI crowding conditions:
 * - OI has been rising
 * - Funding rate is at extreme (positive = longs crowded, negative = shorts crowded)
 * - Price is stalling (potential reversal setup)
 *
 * This indicates a crowded trade that may unwind violently.
 */
@injectable()
export class CrowdingDetector implements IDetector {
  private readonly logger: ILogger;

  // Track OI history per symbol for trend detection
  private oiHistory: Map<string, { ts: number; oi: number }[]> = new Map();

  // Track funding history for extreme detection
  private fundingHistory: Map<string, { ts: number; rate: number }[]> =
    new Map();

  // Cooldowns per symbol
  private cooldowns: Map<string, number> = new Map();

  // Recent detections for deduplication
  private recentDetections: Map<string, number> = new Map();
  private readonly DEDUP_WINDOW_MS = 60000; // 60s dedup window (longer than liq burst)

  // History retention
  private readonly OI_HISTORY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  private readonly FUNDING_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
    @inject(TOKENS.FEATURE_BUILDER) private featureBuilder: FeatureBuilder,
  ) {
    this.logger = logger.child('CrowdingDetector');
    setupEventHandlers(this);
  }

  @EventHandler('features.updated')
  onFeaturesUpdated(data: { symbol: string; features: Features }): void {
    // Update history
    this.updateHistory(data.features);

    // Check for crowding
    const event = this.detect(data.features);
    if (event) {
      this.eventBus.emit('forced-event.detected', event);
    }
  }

  private updateHistory(features: Features): void {
    const { symbol, ts, openInterest, fundingRate } = features;
    const now = ts;

    // Update OI history
    if (openInterest > 0) {
      if (!this.oiHistory.has(symbol)) {
        this.oiHistory.set(symbol, []);
      }
      const oiHist = this.oiHistory.get(symbol)!;
      oiHist.push({ ts: now, oi: openInterest });

      // Prune old entries
      const oiCutoff = now - this.OI_HISTORY_WINDOW_MS;
      this.oiHistory.set(
        symbol,
        oiHist.filter((h) => h.ts > oiCutoff),
      );
    }

    // Update funding history
    if (fundingRate !== 0) {
      if (!this.fundingHistory.has(symbol)) {
        this.fundingHistory.set(symbol, []);
      }
      const fundHist = this.fundingHistory.get(symbol)!;

      // Only add if different from last (funding doesn't change often)
      const last = fundHist[fundHist.length - 1];
      if (!last || last.rate !== fundingRate) {
        fundHist.push({ ts: now, rate: fundingRate });
      }

      // Prune old entries
      const fundCutoff = now - this.FUNDING_HISTORY_WINDOW_MS;
      this.fundingHistory.set(
        symbol,
        fundHist.filter((h) => h.ts > fundCutoff),
      );
    }
  }

  detect(features: Features): ForcedEvent | null {
    const now = features.ts;
    const symbol = features.symbol;

    // Check cooldown
    const cooldownUntil = this.cooldowns.get(symbol) || 0;
    if (now < cooldownUntil) {
      return null;
    }

    // Check dedup
    const lastDetect = this.recentDetections.get(symbol) || 0;
    if (now - lastDetect < this.DEDUP_WINDOW_MS) {
      return null;
    }

    // Get config
    const cfg = this.config.crowding;

    // 1. Check OI trend (should be rising)
    const oiTrend = this.calculateOITrend(symbol);
    if (oiTrend === null || oiTrend < cfg.minOiChangePct) {
      return null;
    }

    // 2. Check funding extreme
    const fundingExtreme = this.checkFundingExtreme(
      symbol,
      features.fundingRate,
    );
    if (!fundingExtreme.isExtreme) {
      return null;
    }

    // 3. Check price stall (price not moving much despite crowding)
    const isStalling = features.stallRangePct10s <= cfg.maxStallRangePct;
    if (!isStalling) {
      return null;
    }

    // 4. Determine side hint based on funding
    // Positive funding = longs pay shorts = longs crowded = expect DOWN
    // Negative funding = shorts pay longs = shorts crowded = expect UP
    const sideHint: 'DOWN' | 'UP' =
      fundingExtreme.direction === 'LONGS_CROWDED' ? 'DOWN' : 'UP';

    // Calculate severity based on how extreme the conditions are
    const oiSeverity = Math.min(1, oiTrend / (cfg.minOiChangePct * 3));
    const fundingSeverity = fundingExtreme.severity;
    const severity = (oiSeverity + fundingSeverity) / 2;

    const event: ForcedEvent = {
      id: uuidv4(),
      ts: now,
      symbol,
      type: 'OI_CROWDING',
      sideHint,
      severity,
      snapshot: features,
      triggerValue: features.fundingRate,
      thresholdValue: cfg.fundingExtremeThreshold,
      cooldownUntil: now + cfg.cooldownSec * 1000,
    };

    // Set cooldown
    this.cooldowns.set(symbol, event.cooldownUntil);
    this.recentDetections.set(symbol, now);

    this.logger.info('📊 OI_CROWDING detected', {
      symbol,
      sideHint,
      severity: severity.toFixed(2),
      oiChange: (oiTrend * 100).toFixed(2) + '%',
      fundingRate: (features.fundingRate * 100).toFixed(4) + '%',
      direction: fundingExtreme.direction,
    });

    return event;
  }

  /**
   * Calculate OI change over the lookback period
   * Returns percentage change (0.05 = 5% increase)
   */
  private calculateOITrend(symbol: string): number | null {
    const history = this.oiHistory.get(symbol);
    if (!history || history.length < 2) {
      return null;
    }

    const lookbackMs = this.config.crowding.oiLookbackMinutes * 60 * 1000;
    const now = Date.now();
    const cutoff = now - lookbackMs;

    // Find oldest entry within lookback
    const oldEntries = history.filter((h) => h.ts <= cutoff);
    const oldOi =
      oldEntries.length > 0
        ? oldEntries[oldEntries.length - 1]!.oi
        : history[0]!.oi;

    const currentOi = history[history.length - 1]!.oi;

    if (oldOi === 0) return null;

    return (currentOi - oldOi) / oldOi;
  }

  /**
   * Check if funding rate is at extreme levels
   */
  private checkFundingExtreme(
    symbol: string,
    currentRate: number,
  ): {
    isExtreme: boolean;
    direction: 'LONGS_CROWDED' | 'SHORTS_CROWDED';
    severity: number;
  } {
    const threshold = this.config.crowding.fundingExtremeThreshold;

    // Funding rate is typically expressed as a percentage per 8h
    // Positive = longs pay shorts (longs crowded)
    // Negative = shorts pay longs (shorts crowded)

    const absRate = Math.abs(currentRate);

    if (absRate < threshold) {
      return { isExtreme: false, direction: 'LONGS_CROWDED', severity: 0 };
    }

    const direction: 'LONGS_CROWDED' | 'SHORTS_CROWDED' =
      currentRate > 0 ? 'LONGS_CROWDED' : 'SHORTS_CROWDED';

    // Severity: how many times above threshold
    const severity = Math.min(1, absRate / (threshold * 3));

    return { isExtreme: true, direction, severity };
  }

  // Allow manual reset of cooldown (for testing)
  resetCooldown(symbol: string): void {
    this.cooldowns.delete(symbol);
    this.recentDetections.delete(symbol);
  }

  getCooldownRemaining(symbol: string): number {
    const cooldownUntil = this.cooldowns.get(symbol) || 0;
    return Math.max(0, cooldownUntil - Date.now());
  }

  // Get current OI trend for a symbol (for monitoring)
  getOITrend(symbol: string): number | null {
    return this.calculateOITrend(symbol);
  }
}
