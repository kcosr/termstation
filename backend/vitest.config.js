import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    threads: true,
    isolate: true,
    include: ['tests/**/*.test.{js,mjs}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['**/*.js', '!tests/**'],
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});

