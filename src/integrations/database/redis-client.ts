import { injectable, inject } from 'tsyringe';
import Redis from 'ioredis';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';

@injectable()
export class RedisClient {
  private client: Redis | null = null;
  private readonly logger: ILogger;

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('Redis');
  }

  async connect(): Promise<void> {
    if (this.client) {
      this.logger.warn('Redis client already connected');
      return;
    }

    try {
      this.client = new Redis(this.config.redis.url, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: true,
      });

      await this.client.connect();
      this.logger.info('Connected to Redis', {
        url: this.config.redis.url.replace(/\/\/.*@/, '//***@'),
      });
    } catch (error) {
      this.logger.error('Failed to connect to Redis', error as Error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.quit();
      this.client = null;
      this.logger.info('Disconnected from Redis');
    } catch (error) {
      this.logger.error('Error disconnecting from Redis', error as Error);
    }
  }

  isConnected(): boolean {
    return this.client?.status === 'ready';
  }

  // ==================== Key-Value Operations ====================

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client) throw new Error('Redis not connected');
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) throw new Error('Redis not connected');
    return this.client.get(key);
  }

  async del(key: string): Promise<void> {
    if (!this.client) throw new Error('Redis not connected');
    await this.client.del(key);
  }

  // ==================== JSON Operations ====================

  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) return null;
    return JSON.parse(value) as T;
  }

  // ==================== List Operations (for rolling windows) ====================

  async lpush(key: string, value: string): Promise<void> {
    if (!this.client) throw new Error('Redis not connected');
    await this.client.lpush(key, value);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    if (!this.client) throw new Error('Redis not connected');
    await this.client.ltrim(key, start, stop);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    if (!this.client) throw new Error('Redis not connected');
    return this.client.lrange(key, start, stop);
  }

  async llen(key: string): Promise<number> {
    if (!this.client) throw new Error('Redis not connected');
    return this.client.llen(key);
  }

  // ==================== Sorted Set Operations (for time-series) ====================

  async zadd(key: string, score: number, member: string): Promise<void> {
    if (!this.client) throw new Error('Redis not connected');
    await this.client.zadd(key, score, member);
  }

  async zrangebyscore(
    key: string,
    min: number,
    max: number,
  ): Promise<string[]> {
    if (!this.client) throw new Error('Redis not connected');
    return this.client.zrangebyscore(key, min, max);
  }

  async zremrangebyscore(key: string, min: number, max: number): Promise<void> {
    if (!this.client) throw new Error('Redis not connected');
    await this.client.zremrangebyscore(key, min, max);
  }

  // ==================== Hash Operations ====================

  async hset(key: string, field: string, value: string): Promise<void> {
    if (!this.client) throw new Error('Redis not connected');
    await this.client.hset(key, field, value);
  }

  async hget(key: string, field: string): Promise<string | null> {
    if (!this.client) throw new Error('Redis not connected');
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    if (!this.client) throw new Error('Redis not connected');
    return this.client.hgetall(key);
  }

  async hincrby(
    key: string,
    field: string,
    increment: number,
  ): Promise<number> {
    if (!this.client) throw new Error('Redis not connected');
    return this.client.hincrby(key, field, increment);
  }

  async hincrbyfloat(
    key: string,
    field: string,
    increment: number,
  ): Promise<string> {
    if (!this.client) throw new Error('Redis not connected');
    return this.client.hincrbyfloat(key, field, increment);
  }
}
