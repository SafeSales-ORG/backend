import { logger } from '../lib/logger.js';
import { autoReleaseDueOrders, retryPendingPayouts } from './escrow.js';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

async function tick(): Promise<void> {
  try {
    const released = await autoReleaseDueOrders();
    if (released > 0) logger.info({ released }, 'Auto-released orders');
    await retryPendingPayouts();
  } catch (err) {
    logger.error({ err }, 'Escrow scheduler tick failed');
  }
}

export function startEscrowScheduler(): NodeJS.Timeout {
  logger.info({ intervalMs: CHECK_INTERVAL_MS }, 'Escrow scheduler started');
  void tick();
  return setInterval(tick, CHECK_INTERVAL_MS);
}
