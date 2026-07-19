import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from './vitest.config'

export default mergeConfig(baseConfig, defineConfig({
  test: {
    include: [
      'packages/*/src/__tests__/**/*.test.ts',
      'mcp/src/__tests__/**/*.test.ts',
      'scripts/release/**/*.test.ts',
    ],
    exclude: [
      // Slower or threshold-based suites still run via `npm run test:all` / `npm run release:gate` (see TESTING_MATRIX.md).
      'packages/core/src/__tests__/fonts.test.ts', // WASM / web font loading
      'packages/core/src/__tests__/perf-smoke.test.ts', // timing smoke thresholds
      'packages/core/src/__tests__/virtual-scroll.test.ts', // large exhaustive grid (window indices / corrupt props)
      'packages/server/src/__tests__/protocol-perf-smoke.test.ts', // server timing smoke thresholds
    ],
  },
}))
