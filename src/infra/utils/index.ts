import Decimal from 'decimal.js';

export class RetryUtils {
  static calculateDelay(
    attempt: number,
    baseDelay: number,
    maxDelay: number,
    factor: number = 2,
  ): number {
    const delay = baseDelay * Math.pow(factor, attempt - 1);
    return Math.min(delay, maxDelay);
  }

  static async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  static async retry<T>(
    fn: () => Promise<T>,
    {
      maxRetries = 3,
      baseDelay = 500,
      maxDelay = 2000,
      nackErrors,
    }: {
      maxRetries?: number;
      baseDelay?: number;
      maxDelay?: number;
      nackErrors?: any[];
    } = {},
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (nackErrors?.length && nackErrors.some((e) => error instanceof e)) {
          throw error;
        }

        lastError = error as Error;

        if (attempt > maxRetries) {
          throw lastError;
        }

        const delay = this.calculateDelay(attempt, baseDelay, maxDelay);
        await this.sleep(delay);
      }
    }

    throw lastError!;
  }
}

export class DebounceUtils {
  private static timeouts = new Map<string, NodeJS.Timeout>();

  static debounce<T extends (...args: any[]) => any>(
    key: string,
    fn: T,
    wait: number,
    immediate: boolean = false,
  ): T {
    return ((...args: Parameters<T>) => {
      const existingTimeout = this.timeouts.get(key);

      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      if (immediate && !existingTimeout) {
        fn(...args);
      }

      const timeout = setTimeout(() => {
        this.timeouts.delete(key);
        if (!immediate) {
          fn(...args);
        }
      }, wait);

      this.timeouts.set(key, timeout);
    }) as T;
  }

  static clear(key: string): void {
    const timeout = this.timeouts.get(key);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(key);
    }
  }

  static clearAll(): void {
    this.timeouts.forEach((timeout) => clearTimeout(timeout));
    this.timeouts.clear();
  }

  static isPending(key: string): boolean {
    return this.timeouts.has(key);
  }

  static getPendingCount(): number {
    return this.timeouts.size;
  }
}

export class MathUtils {
  static calculatePercentageDifference(value1: number, value2: number): number {
    return Math.abs(((value2 - value1) / value1) * 100);
  }

  static calculatePercentageDifferenceDecimal(
    value1: Decimal,
    value2: Decimal,
    convertToPercentage: boolean = false,
  ): Decimal {
    const difference = value2.minus(value1).abs();
    if (convertToPercentage) {
      return difference.mul(100);
    }
    return difference;
  }

  /**
   * Calculate standard deviation of an array of numbers
   */
  static stdDev(values: number[]): number {
    if (values.length === 0) return 0;
    const n = values.length;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance =
      values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
      (n > 1 ? n - 1 : 1);
    return Math.sqrt(variance);
  }

  /**
   * Calculate percentile of an array
   */
  static percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower]!;
    return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
  }

  /**
   * Calculate median of an array
   */
  static median(values: number[]): number {
    return this.percentile(values, 50);
  }
}

export class SleepUtils {
  static async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
