import http from 'node:http';
import { loadDotEnv, readConfig } from './config.ts';
import { createApp } from './app.ts';
import { startJobs } from './jobs.ts';
import { logger } from './logger.ts';

loadDotEnv();
let config;
try {
  config = readConfig();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const app = createApp(config);
const server = http.createServer((req, res) => {
  void app.handle(req, res);
});
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

const stopJobs = startJobs(app);

server.listen(config.PORT, config.HOST, () => {
  logger.info('server_started', { url: config.APP_URL, host: config.HOST, port: config.PORT, env: config.NODE_ENV, payments: app.payments.name });
  if (app.payments.isSandbox) logger.warn('sandbox_payments_active', { note: 'No real money is collected. Configure Razorpay before launch.' });
});

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  logger.info('shutting_down', { signal });
  stopJobs();
  server.close();
  setTimeout(() => process.exit(0), 8000).unref();
  await app.close().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => logger.error('unhandled_rejection', { err: e }));
