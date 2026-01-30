import 'reflect-metadata'; // do not remove this line. It is required by tsyringe

import { App } from './app';
import { diContainer } from './di/di-container';

async function main() {
  let app!: App;

  try {
    diContainer.configure();

    app = diContainer.resolve<App>(App);

    await app.start();
  } catch (e) {
    console.error('Failed to start application:', e);

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

// Handle unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start the application
main().catch(error => {
  console.error('Fatal error in main:', error);
  process.exit(1);
});
