import { defineConfig, devices } from 'playwright/test';
import { loadDotEnv } from './src/server/config.ts';

loadDotEnv();
const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Browser tests run against the PRODUCTION BUILD (`npm run build` first) on the
 * disposable TEST database, with the sandbox payment gateway.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: 'node dist/server.mjs',
    url: `${BASE}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      APP_URL: BASE,
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123456789',
      PAYMENT_PROVIDER: 'sandbox',
      SANDBOX_PAYMENT_SECRET: 'e2e-sandbox-secret-0123456789abcdef0123456789',
      MAIL_DRIVER: 'database',
      PRESCRIPTION_STORAGE_DIR: './storage/e2e-prescriptions',
      LOG_LEVEL: 'warn',
    },
  },
});
