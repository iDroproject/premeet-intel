import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    test: {
      include: ['tests/**/*.test.ts'],
      testTimeout: 60_000,
      hookTimeout: 30_000,
      fileParallelism: false,
      env,
    },
  };
});
