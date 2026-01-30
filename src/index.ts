import 'reflect-metadata'; // Required by tsyringe - DO NOT REMOVE

import { App } from './app';
import { diContainer } from './di/di-container';

async function main() {
  let app: App | undefined;

  try {
    // Configure DI container
    diContainer.configure();

    // Resolve and start application
    app = diContainer.resolve<App>(App);
    await app.start();

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\nReceived ${signal}. Shutting down gracefully...`);

      if (app) {
        try {
          await app.stop();
        } catch (error) {
          console.error('Error during shutdown:', error);
        }
      }

      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
  } catch (error) {
    console.error('Failed to start application:', error);

    if (app) {
      try {
        await app.stop();
      } catch (stopError) {
        console.error('Failed to stop application:', stopError);
      }
    }

    process.exit(1);
  }
}

main();
