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
    // Integration files share one Postgres database and truncate the ledger
    // between cases, so files run one at a time. The suite is small enough
    // that this costs a fraction of a second and removes a whole class of
    // cross-file flake.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 15_000,
    hookTimeout: 20_000,
    reporters: process.env.CI ? ['default'] : ['dot'],
  },
});
