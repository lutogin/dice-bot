import winston from 'winston';
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

  constructor(@inject(TOKENS.CONFIG_SERVICE) private config: ConfigService) {
    const transports: winston.transport[] = [];
    const isProduction = this.config.isProduction();

    const logsDir = isProduction
      ? '/app/logs'
      : path.resolve(process.cwd(), 'logs');

    if (!fs.existsSync(logsDir)) {
      try {
        fs.mkdirSync(logsDir, { recursive: true });
        console.log(`[Logger] Created logs directory: ${logsDir}`);
      } catch (err) {
        console.warn(
          `[Logger] Could not create logs directory ${logsDir}: ${(err as Error).message}`,
        );
      }
    }

    const prettyFormat = winston.format.printf(
      ({ timestamp, level, message, service, ...meta }) => {
        const metaStr = Object.keys(meta).length
          ? JSON.stringify(meta, null, 2)
          : '';
        return `${timestamp} [${service}] ${level}: ${message} ${metaStr}`;
      },
    );

    // Error log always to file
    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        maxsize: 5242880,
        maxFiles: 5,
        format: winston.format.combine(
          winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
          winston.format.errors({ stack: true }),
          prettyFormat,
        ),
      }),
    );

    if (process.env['LOG_TO_FILE'] === 'true') {
      transports.push(
        new winston.transports.File({
          filename: path.join(logsDir, 'combined.log'),
          maxsize: 5242880,
          maxFiles: 5,
          format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            prettyFormat,
          ),
        }),
      );
    }

    // Console transport
    transports.push(
      new winston.transports.Console({
        format: isProduction
          ? winston.format.combine(
              winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
              winston.format.errors({ stack: true }),
              prettyFormat,
            )
          : winston.format.combine(
              winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
              winston.format.colorize(),
              prettyFormat,
            ),
      }),
    );

    this.logger = winston.createLogger({
      level: this.config.logLevel,
      defaultMeta: { service: 'ffe-bot' },
      transports,
      exitOnError: false,
    });

    this.logger.on('error', (err) => {
      console.error('[Logger] Transport error (continuing):', err.message);
    });
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
