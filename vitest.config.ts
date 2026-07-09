import path from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    // Node by default (API routes, pure logic); hook/component tests opt into
    // jsdom with a `// @vitest-environment jsdom` docblock.
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
