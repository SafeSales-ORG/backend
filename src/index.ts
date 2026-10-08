import { env } from './env.js';
import { logger } from './lib/logger.js';
import { buildApp } from './app.js';
import { startEscrowScheduler } from './services/scheduler.js';

async function start() {
  const app = await buildApp();
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    logger.info({ port: env.PORT, payments: env.PAYMENT_PROVIDER }, 'Server started');
    startEscrowScheduler();
  } catch (err) {
    logger.fatal({ err }, 'Failed to start server');
    process.exit(1);
  }
}

start();
