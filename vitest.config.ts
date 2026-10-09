import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // One database shared by all tests — run files sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-00',
      PAYMENT_PROVIDER: 'mock',
      PAYMENT_SIMULATION: 'true',
      PLATFORM_FEE_BPS: '150',
      AUTO_RELEASE_DAYS: '7',
      MEDIATOR_EMAIL: 'mediator@safesale.test',
      MEDIATOR_PASSWORD: 'mediator-test-password',
      GOOGLE_CLIENT_ID: 'safesale-test-client.apps.googleusercontent.com',
      FRONTEND_ORIGINS: 'http://localhost:8080',
      AUTH_RATE_LIMIT_PER_MIN: '1000',
      STORAGE_PROVIDER: 'local',
      STORAGE_LOCAL_DIR: './.test-uploads',
    },
  },
});
