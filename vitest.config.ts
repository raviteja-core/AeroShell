import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/native/**/*.test.ts', 'tests/main/**/*.test.ts'],
    environment: 'node',
  },
});
