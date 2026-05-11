import { startBot } from './bot';
import { logger } from './logger';

// Handle uncaught exceptions gracefully
process.on('uncaughtException', (error) => {
  logger.fatal(error, 'Uncaught Exception');
  // Give it a moment to log before exiting (PM2 will restart)
  setTimeout(() => process.exit(1), 1000);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled Rejection');
  setTimeout(() => process.exit(1), 1000);
});

// Start the application
logger.info('Starting up 24/7 Discord Voice Bot...');
startBot();
