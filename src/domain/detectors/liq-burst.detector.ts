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

@injectable()
export class LiqBurstDetector implements IDetector {
  private readonly logger: ILogger;

  // Track cooldowns per symbol
  private cooldowns: Map<string, number> = new Map();

  // Store recent detections for deduplication
  private recentDetections: Map<string, number> = new Map();
  private readonly DEDUP_WINDOW_MS = 5000; // 5s dedup window

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
    @inject(TOKENS.FEATURE_BUILDER) private featureBuilder: FeatureBuilder,
  ) {
    this.logger = logger.child('LiqBurstDetector');
    setupEventHandlers(this);
  }

  @EventHandler('features.updated')
  onFeaturesUpdated(data: { symbol: string; features: Features }): void {
    const event = this.detect(data.features);
    if (event) {
      this.eventBus.emit('forced-event.detected', event);
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

    // Get baselines
    const baselines = this.featureBuilder.getBaselines(symbol);
    const medianLiqNotional =
      baselines?.medianLiqNotional30s1h ||
      this.config.liqBurst.minLiqNotionalAbs / 10;

    // Calculate threshold
    const threshold = Math.max(
      this.config.liqBurst.minLiqNotionalAbs,
      this.config.liqBurst.kMedian * medianLiqNotional,
    );

    // Detection conditions:
    // 1. Liquidation notional exceeds threshold
    // 2. Absolute return exceeds minimum
    const liqExceedsThreshold = features.liqNotional30s > threshold;
    const retExceedsMin =
      Math.abs(features.ret30s) > this.config.liqBurst.minRet30sPct;

    if (!liqExceedsThreshold || !retExceedsMin) {
      return null;
    }

    // Additional quality filters:
    // - Volatility should be elevated (but not check this strictly for now)
    // - Direction of return should match liquidation direction

    // Determine side hint
    const sideHint: 'DOWN' | 'UP' = features.ret30s < 0 ? 'DOWN' : 'UP';

    // Calculate severity (0-1)
    const severityRaw = features.liqNotional30s / threshold;
    const severity = Math.min(1, severityRaw / 3); // Cap at 3x threshold = severity 1

    const event: ForcedEvent = {
      id: uuidv4(),
      ts: now,
      symbol,
      type: 'LIQ_BURST',
      sideHint,
      severity,
      snapshot: features,
      triggerValue: features.liqNotional30s,
      thresholdValue: threshold,
      cooldownUntil: now + this.config.liqBurst.cooldownSec * 1000,
    };

    // Set cooldown
    this.cooldowns.set(symbol, event.cooldownUntil);
    this.recentDetections.set(symbol, now);

    this.logger.info('🔥 LIQ_BURST detected', {
      symbol,
      sideHint,
      severity: severity.toFixed(2),
      liqNotional: features.liqNotional30s.toFixed(0),
      threshold: threshold.toFixed(0),
      ret30s: (features.ret30s * 100).toFixed(2) + '%',
    });

    return event;
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
}
