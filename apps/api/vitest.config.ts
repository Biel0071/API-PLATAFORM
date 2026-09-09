import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', '../../qa/contracts/**/*.test.ts'],
    environment: 'node',
    env: {
      DATABASE_URL: 'postgresql://aiplatform:aiplatform@localhost:5433/aiplatform?schema=public',
      JWT_SECRET: 'testsecretatleast16characterslong',
      REDIS_URL: 'redis://localhost:6379',
    },
  },
});
