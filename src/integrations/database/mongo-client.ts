import { injectable, inject } from 'tsyringe';
import { MongoClient, Db, Collection, Document } from 'mongodb';
import { TOKENS } from '../../di/tokens';
import { ConfigService } from '../../config';
import { Logger, ILogger } from '../../infra/logger/logger';

@injectable()
export class MongoDBClient {
  private client: MongoClient | null = null;
  private db: Db | null = null;
  private readonly logger: ILogger;

  constructor(
    @inject(TOKENS.CONFIG_SERVICE) private config: ConfigService,
    @inject(TOKENS.LOGGER) logger: Logger,
  ) {
    this.logger = logger.child('MongoDB');
  }

  async connect(): Promise<void> {
    if (this.client) {
      this.logger.warn('MongoDB client already connected');
      return;
    }

    try {
      this.client = new MongoClient(this.config.mongo.url);
      await this.client.connect();

      this.db = this.client.db(this.config.mongo.dbName);

      // Create indexes
      await this.createIndexes();

      this.logger.info('Connected to MongoDB', {
        url: this.config.mongo.url.replace(/\/\/.*@/, '//***@'),
        database: this.config.mongo.dbName,
      });
    } catch (error) {
      this.logger.error('Failed to connect to MongoDB', error as Error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.close();
      this.client = null;
      this.db = null;
      this.logger.info('Disconnected from MongoDB');
    } catch (error) {
      this.logger.error('Error disconnecting from MongoDB', error as Error);
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.db !== null;
  }

  getDb(): Db {
    if (!this.db) throw new Error('MongoDB not connected');
    return this.db;
  }

  getCollection<T extends Document>(name: string): Collection<T> {
    return this.getDb().collection<T>(name);
  }

  private async createIndexes(): Promise<void> {
    if (!this.db) return;

    this.logger.info('Creating MongoDB indexes...');

    // Forced Events indexes
    const eventsCol = this.db.collection('forced_events');
    await eventsCol.createIndex({ symbol: 1 });
    await eventsCol.createIndex({ ts: -1 });
    await eventsCol.createIndex({ type: 1 });
    await eventsCol.createIndex({ symbol: 1, ts: -1 });

    // Trade Plans indexes
    const plansCol = this.db.collection('trade_plans');
    await plansCol.createIndex({ symbol: 1 });
    await plansCol.createIndex({ status: 1 });
    await plansCol.createIndex({ eventId: 1 });
    await plansCol.createIndex({ createdAt: -1 });

    // Trades indexes
    const tradesCol = this.db.collection('trades');
    await tradesCol.createIndex({ symbol: 1 });
    await tradesCol.createIndex({ closedAt: -1 });
    await tradesCol.createIndex({ result: 1 });
    await tradesCol.createIndex({ planId: 1 });

    this.logger.info('MongoDB indexes created');
  }
}
