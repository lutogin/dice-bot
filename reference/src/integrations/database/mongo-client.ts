import { injectable, inject } from 'tsyringe';
import mongoose, { Connection } from 'mongoose';
import { Logger, ILogger } from '../../infra/logger/logger';
import { ConfigService } from '../../config';
import { TOKENS } from '../../di/tokens';

@injectable()
export class MongoClient {
  private connection: Connection | null = null;
  private isRunning = false;
  private readonly logger: ILogger;

  constructor(
    @inject(TOKENS.LOGGER) logger: Logger,
    @inject(TOKENS.CONFIG_SERVICE) private configService: ConfigService
  ) {
    this.logger = logger.child('MongoDB');
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn(`${MongoClient.name} is already running`);
      return;
    }

    try {
      const mongoUri = this.configService.database.uri;

      this.logger.info(`🔌 Connecting to MongoDB: ${mongoUri.replace(/\/\/.*@/, '//***@')}`);

      await mongoose.connect(mongoUri);
      this.connection = mongoose.connection;
      this.isRunning = true;

      this.logger.info('✅ MongoDB connected successfully');
    } catch (error) {
      this.logger.error('❌ Failed to connect to MongoDB:', error as Error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      if (this.connection) {
        await mongoose.disconnect();
        this.connection = null;
      }

      this.isRunning = false;
      this.logger.info('🔌 MongoDB disconnected');
    } catch (error) {
      this.logger.error('❌ Error disconnecting from MongoDB:', error as Error);
      throw error;
    }
  }

  getConnection(): Connection | null {
    return this.connection;
  }

  isConnected(): boolean {
    return this.isRunning && this.connection?.readyState === 1;
  }
}
