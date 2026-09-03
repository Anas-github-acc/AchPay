import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // NODE_ENV=test routes config at src/config.ts to TEST_DATABASE_URL and a
    // prefixed Redis keyspace, so a test run never touches dev data.
    env: { NODE_ENV: 'test' },
    // Threads with isolate:false reuse one worker context per file, which keeps
    // the Postgres pool and Redis connection warm across the suite.
    pool: 'threads',
    isolate: false,
    fileParallelism: true,
    // Integration files that share the ledger table run one at a time; unit
    // files have no shared state. See tests/integration/*.test.ts.
    sequence: { concurrent: false },
    testTimeout: 15_000,
    hookTimeout: 20_000,
    reporters: process.env.CI ? ['default'] : ['dot'],
  },
});
