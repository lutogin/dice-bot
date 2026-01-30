import { Features } from '../features/features.types';

export type ForcedEventType = 'LIQ_BURST' | 'OI_CROWDING';

/**
 * Forced event detected by detectors
 */
export interface ForcedEvent {
  id: string;
  ts: number;
  symbol: string;
  type: ForcedEventType;
  sideHint: 'DOWN' | 'UP'; // Direction of impulse
  severity: number; // 0..1 normalized severity
  snapshot: Features;

  // Detection metadata
  triggerValue: number; // e.g., liq notional that triggered
  thresholdValue: number; // threshold that was exceeded
  cooldownUntil: number; // timestamp until which we're in cooldown
}

/**
 * Detector configuration interface
 */
export interface IDetector {
  detect(features: Features): ForcedEvent | null;
}
