import winston from 'winston';
import LokiTransport from 'winston-loki';
import { injectable, inject } from 'tsyringe';
import fs from 'fs';
import path from 'path';
import { ConfigService } from '../../config';
import { TOKENS } from '../../di/tokens';

export interface ILogger {
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, error?: Error | null | undefined, meta?: any): void;
  debug(message: string, meta?: any): void;
  child(serviceName: string): ILogger;
}

@injectable()
export class Logger implements ILogger {
  private logger: winston.Logger;
  private lastLokiError?: number;

  constructor(@inject(TOKENS.CONFIG_SERVICE) private config: ConfigService) {
    const transports: winston.transport[] = [];
    const isProduction = this.config.isProduction();

    // Use absolute path for Docker compatibility
    // In Docker: /app/logs, locally: {project}/logs
    const logsDir = isProduction ? '/app/logs' : path.resolve(process.cwd(), 'logs');
    
    // Ensure logs directory exists
    if (!fs.existsSync(logsDir)) {
      try {
        fs.mkdirSync(logsDir, { recursive: true });
        console.log(`[Logger] Created logs directory: ${logsDir}`);
      } catch (err) {
        console.warn(`[Logger] Could not create logs directory ${logsDir}: ${(err as Error).message}`);
      }
    }

    // Pretty format for logs
    const prettyFormat = winston.format.printf(
      ({ timestamp, level, message, service, ...meta }) => {
        const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
        return `${timestamp} [${service}] ${level}: ${message} ${metaStr}`;
      }
    );

    // Error log always to file
    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        maxsize: 5242880, // 5MB
        maxFiles: 5,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.errors({ stack: true }),
          prettyFormat
        ),
      })
    );

    if (process.env.LOG_TO_FILE === 'true') {
      transports.push(
        new winston.transports.File({
          filename: path.join(logsDir, 'combined.log'),
          maxsize: 5242880, // 5MB
          maxFiles: 5,
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            prettyFormat
          ),
        })
      );
    }

    // Console - always works, never blocks
    transports.push(
      new winston.transports.Console({
        format: isProduction
          ? winston.format.combine(
              winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
              winston.format.errors({ stack: true }),
              prettyFormat
            )
          : winston.format.combine(
              winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
              winston.format.colorize(),
              prettyFormat
            ),
      })
    );

    // Loki transport for production - FIRE AND FORGET
    // If Loki fails, we just drop logs silently to not block the app
    if (isProduction && process.env.LOKI_HOST) {
      try {
        const lokiTransport = new LokiTransport({
          host: process.env.LOKI_HOST,
          labels: { app: 'atlas-trading-bot' },
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            prettyFormat
          ),
          json: true,
          replaceTimestamp: true,
          onConnectionError: (err: Error & { code?: string }) => {
            // Rate-limit error logging to once per 5 minutes
            const now = Date.now();
            if (!this.lastLokiError || now - this.lastLokiError > 300000) {
              console.warn('[Logger] Loki error (logs still go to console):', err.code || err.message);
              this.lastLokiError = now;
            }
          },
          basicAuth: `${process.env.LOKI_USER}:${process.env.LOKI_TOKEN}`,
          batching: true,
          interval: 5,
          gracefulShutdown: false, // Don't wait for Loki on shutdown
          clearOnError: true, // CRITICAL: clear batch on error to prevent blocking
          level: this.config.logLevel,
        });

        transports.push(lokiTransport);
      } catch (err) {
        console.error('[Logger] Failed to create Loki transport:', (err as Error).message);
        // Continue without Loki - console will still work
      }
    }

    this.logger = winston.createLogger({
      level: this.config.logLevel,
      defaultMeta: { service: 'atlas-trading-bot' },
      transports,
      // CRITICAL: Don't let transport errors crash the app
      exitOnError: false,
    });

    // Handle transport errors gracefully
    this.logger.on('error', (err) => {
      console.error('[Logger] Transport error (continuing):', err.message);
    });

    if (isProduction && process.env.LOKI_HOST) {
      console.log('[Logger] Loki transport enabled (fire-and-forget mode)');
    }
  }

  info(message: string, meta?: any): void {
    this.logger.info(message, meta);
  }

  warn(message: string, meta?: any): void {
    this.logger.warn(message, meta);
  }

  error(message: string, error?: Error, meta?: any): void {
    const errorMeta = error
      ? {
          stack: error.stack,
          name: error.name,
          message: error.message,
          ...meta,
        }
      : meta;

    this.logger.error(message, errorMeta);
  }

  debug(message: string, meta?: any): void {
    this.logger.debug(message, meta);
  }

  /**
   * Создает child logger с предустановленным именем сервиса
   */
  child(serviceName: string): ILogger {
    const parentLogger = this.logger;
    return {
      info: (message: string, meta?: any) => {
        parentLogger.info(message, { ...meta, service: serviceName });
      },
      warn: (message: string, meta?: any) => {
        parentLogger.warn(message, { ...meta, service: serviceName });
      },
      error: (message: string, error?: Error, meta?: any) => {
        const errorMeta = error
          ? {
              stack: error.stack,
              name: error.name,
              message: error.message,
              ...meta,
              service: serviceName,
            }
          : { ...meta, service: serviceName };
        parentLogger.error(message, errorMeta);
      },
      debug: (message: string, meta?: any) => {
        parentLogger.debug(message, { ...meta, service: serviceName });
      },
      child: (childName: string) => {
        return this.child(`${serviceName}.${childName}`);
      },
    };
  }
}
