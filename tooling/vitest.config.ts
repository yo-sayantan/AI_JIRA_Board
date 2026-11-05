import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}', 'server/**/*.test.mjs'],
    coverage: {
      thresholds: {
        statements: 72,
        branches: 62,
        functions: 70,
        lines: 75,
      },
    },
  },
})
