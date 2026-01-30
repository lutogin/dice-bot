import { injectable, inject } from 'tsyringe';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { EventBus } from '../../infra/event-bus/event-bus';
import { ForcedEvent } from '../detectors/detector.types';
import { FeatureBuilder } from '../features/features.service';
import {
  setupEventHandlers,
  EventHandler,
} from '../../infra/event-bus/event-bus.decorators';

export interface ClassificationResult {
  passed: boolean;
  reason?: string;
  score?: number;
}

@injectable()
export class SignalClassifier {
  private readonly logger: ILogger;

  // Stats for monitoring
  private stats = {
    total: 0,
    passed: 0,
    rejected: 0,
    rejectionReasons: new Map<string, number>(),
  };

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.EVENT_BUS) private eventBus: EventBus,
    @inject(TOKENS.FEATURE_BUILDER) private featureBuilder: FeatureBuilder,
  ) {
    this.logger = logger.child(SignalClassifier.name);
    setupEventHandlers(this);
  }

  @EventHandler('forced-event.detected')
  onForcedEvent(event: ForcedEvent): void {
    const result = this.classify(event);

    this.eventBus.emit('signal.classified', {
      event,
      passed: result.passed,
      reason: result.reason,
    });
  }

  classify(event: ForcedEvent): ClassificationResult {
    this.stats.total++;

    const { snapshot } = event;
    const reasons: string[] = [];

    // ==================== Filter Rules ====================
    // Philosophy: Better to not trade than to trade noise

    // 1. Minimum severity (filter out weak events)
    if (event.severity < 0.3) {
      reasons.push('severity_too_low');
    }

    // 2. Spread check - don't trade on wide spreads
    if (snapshot.spreadPct > 0.002) {
      // > 0.2% spread
      reasons.push('spread_too_wide');
    }

    // 3. Return magnitude check - should be significant
    if (Math.abs(snapshot.ret30s) < this.config.liqBurst.minRet30sPct * 0.8) {
      reasons.push('return_too_small');
    }

    // 4. Volatility check - should be elevated but not extreme
    // Skip for now as we don't have 24h percentile baselines yet

    // 5. CVD divergence check - CVD should align with impulse direction
    // For DOWN impulse, CVD should be negative (selling pressure)
    // For UP impulse, CVD should be positive (buying pressure)
    const cvdAligned =
      (event.sideHint === 'DOWN' && snapshot.cvd30s < 0) ||
      (event.sideHint === 'UP' && snapshot.cvd30s > 0);
    if (!cvdAligned) {
      reasons.push('cvd_not_aligned');
    }

    // 6. Sufficient liquidity in book for exit
    // We need book to be reasonably populated
    // Skip for now

    // 7. Liquidation count check - true cascades usually have multiple liquidations
    if (snapshot.liqCount30s < 3) {
      reasons.push('liq_count_too_low');
    }

    // ==================== Pass/Fail Decision ====================

    if (reasons.length === 0) {
      this.stats.passed++;

      this.logger.info('✅ Signal PASSED classification', {
        symbol: event.symbol,
        type: event.type,
        severity: event.severity.toFixed(2),
      });

      return {
        passed: true,
        score: event.severity,
      };
    } else {
      this.stats.rejected++;

      // Track rejection reasons
      for (const reason of reasons) {
        const count = this.stats.rejectionReasons.get(reason) || 0;
        this.stats.rejectionReasons.set(reason, count + 1);
      }

      const reason = reasons.join(',');

      this.logger.debug('❌ Signal REJECTED', {
        symbol: event.symbol,
        type: event.type,
        reasons,
      });

      return {
        passed: false,
        reason,
      };
    }
  }

  // ==================== Stats API ====================

  getStats(): {
    total: number;
    passed: number;
    rejected: number;
    passRate: number;
    rejectionReasons: Record<string, number>;
  } {
    const passRate =
      this.stats.total > 0 ? this.stats.passed / this.stats.total : 0;

    return {
      total: this.stats.total,
      passed: this.stats.passed,
      rejected: this.stats.rejected,
      passRate,
      rejectionReasons: Object.fromEntries(this.stats.rejectionReasons),
    };
  }

  resetStats(): void {
    this.stats = {
      total: 0,
      passed: 0,
      rejected: 0,
      rejectionReasons: new Map(),
    };
  }
}
