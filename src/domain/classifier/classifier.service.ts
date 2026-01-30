import { injectable, inject } from 'tsyringe';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';
import { EventBus } from '../../infra/event-bus/event-bus';
import { ForcedEvent } from '../detectors/detector.types';
import { FeatureBuilder } from '../features/features.service';
import { DataIntegrityGuard } from '../data-integrity/data-integrity.service';
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
    @inject(TOKENS.DATA_INTEGRITY_GUARD)
    private dataIntegrity: DataIntegrityGuard,
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

    // ==================== DATA INTEGRITY CHECK (MUST PASS) ====================
    const dataCheck = this.dataIntegrity.canTrade(event.symbol);
    if (!dataCheck.allowed) {
      reasons.push(`data_integrity:${dataCheck.reason}`);
      this.recordRejection(reasons);

      this.logger.warn('❌ Signal REJECTED - data integrity failed', {
        symbol: event.symbol,
        reason: dataCheck.reason,
      });

      return { passed: false, reason: reasons.join(',') };
    }

    // ==================== Filter Rules ====================
    // Philosophy: Better to not trade than to trade noise

    // 1. Minimum severity (filter out weak events)
    if (event.severity < 0.3) {
      reasons.push('severity_too_low');
    }

    // 2. Spread check - don't trade on wide spreads
    if (snapshot.spreadPct > 0.002) {
      reasons.push('spread_too_wide');
    }

    // 3. Return magnitude check - should be significant
    if (Math.abs(snapshot.ret30s) < this.config.liqBurst.minRet30sPct * 0.8) {
      reasons.push('return_too_small');
    }

    // 4. Volatility check - use adaptive threshold
    // Get current baselines for context
    const baselines = this.featureBuilder.getBaselines(event.symbol);
    if (baselines && baselines.p90Rv30s24h > 0) {
      // If current rv is way above p90, market might be too chaotic
      if (snapshot.rv30s > baselines.p90Rv30s24h * 2) {
        reasons.push('volatility_extreme');
      }
    }

    // 5. CVD divergence check - CVD should align with impulse direction
    const cvdAligned =
      (event.sideHint === 'DOWN' && snapshot.cvd30s < 0) ||
      (event.sideHint === 'UP' && snapshot.cvd30s > 0);
    if (!cvdAligned) {
      reasons.push('cvd_not_aligned');
    }

    // 6. Liquidation count check - true cascades usually have multiple liquidations
    if (snapshot.liqCount30s < 3) {
      reasons.push('liq_count_too_low');
    }

    // 7. Book depth check - need sufficient liquidity
    // This is now handled by DataIntegrityGuard, but we can add extra check
    if (snapshot.spreadPct > 0.0015 && snapshot.rv30s > 0.002) {
      // Wide spread + high vol = dangerous
      reasons.push('market_quality_poor');
    }

    // ==================== Pass/Fail Decision ====================

    if (reasons.length === 0) {
      this.stats.passed++;

      this.logger.info('✅ Signal PASSED classification', {
        symbol: event.symbol,
        type: event.type,
        severity: event.severity.toFixed(2),
        ret30s: (snapshot.ret30s * 100).toFixed(2) + '%',
        liqNotional: (snapshot.liqNotional30s / 1_000_000).toFixed(1) + 'M',
      });

      return {
        passed: true,
        score: event.severity,
      };
    } else {
      this.recordRejection(reasons);

      this.logger.debug('❌ Signal REJECTED', {
        symbol: event.symbol,
        type: event.type,
        reasons,
        severity: event.severity.toFixed(2),
      });

      return {
        passed: false,
        reason: reasons.join(','),
      };
    }
  }

  private recordRejection(reasons: string[]): void {
    this.stats.rejected++;
    for (const reason of reasons) {
      const count = this.stats.rejectionReasons.get(reason) || 0;
      this.stats.rejectionReasons.set(reason, count + 1);
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
