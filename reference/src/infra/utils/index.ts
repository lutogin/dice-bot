import Decimal from 'decimal.js';

export class RetryUtils {
  /**
   * Exponential backoff delay calculator
   */
  static calculateDelay(
    attempt: number,
    baseDelay: number,
    maxDelay: number,
    factor: number = 2
  ): number {
    const delay = baseDelay * Math.pow(factor, attempt - 1);
    return Math.min(delay, maxDelay);
  }

  /**
   * Sleep for specified milliseconds
   */
  static async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Retry function with exponential backoff
   */
  static async retry<T>(
    fn: () => Promise<T>,
    {
      maxRetries = 3,
      baseDelay = 500,
      maxDelay = 2000,
      nackErrors,
    }: { maxRetries?: number; baseDelay?: number; maxDelay?: number; nackErrors?: any[] } = {}
  ): Promise<T> {
    let lastError: Error;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (nackErrors?.length && nackErrors.some(e => error instanceof e)) {
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

  /**
   * Debounce function calls - delays execution until after wait milliseconds have passed since the last invocation
   * @param key Unique key to identify the debounced function
   * @param fn Function to debounce
   * @param wait Delay in milliseconds
   * @param immediate If true, execute immediately on first call
   */
  static debounce<T extends (...args: any[]) => any>(
    key: string,
    fn: T,
    wait: number,
    immediate: boolean = false
  ): T {
    return ((...args: Parameters<T>) => {
      const existingTimeout = this.timeouts.get(key);

      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      if (immediate && !existingTimeout) {
        // Выполняем сразу при первом вызове
        fn(...args);
      }

      const timeout = setTimeout(() => {
        this.timeouts.delete(key);
        if (!immediate) {
          // Выполняем после задержки (стандартный debounce)
          fn(...args);
        }
      }, wait);

      this.timeouts.set(key, timeout);
    }) as T;
  }

  /**
   * Clear debounce timeout for specific key
   */
  static clear(key: string): void {
    const timeout = this.timeouts.get(key);
    if (timeout) {
      clearTimeout(timeout);
      this.timeouts.delete(key);
    }
  }

  /**
   * Clear all debounce timeouts
   */
  static clearAll(): void {
    this.timeouts.forEach(timeout => clearTimeout(timeout));
    this.timeouts.clear();
  }

  /**
   * Check if debounce is pending for specific key
   */
  static isPending(key: string): boolean {
    return this.timeouts.has(key);
  }

  /**
   * Get count of pending debounces
   */
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
    convertToPercentage: boolean = false
  ): Decimal {
    const difference = value2.minus(value1).abs();
    if (convertToPercentage) {
      return difference.mul(100);
    }
    return difference;
  }
}

export class SleepUtils {
  static async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
