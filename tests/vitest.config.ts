import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

/**
 * Two projects:
 *  - unit: pure logic, no database, no network. Always runnable.
 *  - db:   integration tests against a THROWAWAY local PostgreSQL started by
 *          db/global-setup.ts. They can never reach production: the setup
 *          refuses any DATABASE_URL that is not localhost, and nothing here
 *          reads the repository's .env (which points at production).
 *
 * Run from the repository root:  npm --prefix tests test
 * Never chain this into `npm run build`.
 */
export default defineConfig({
  root: here,
  resolve: { alias: { '@': path.join(root, 'src') } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['unit/**/*.test.ts'], environment: 'node' },
      },
      {
        extends: true,
        test: {
          name: 'db',
          include: ['db/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['./db/global-setup.ts'],
          setupFiles: ['./db/guard.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Rehearsal against the LOCAL COPY of production data (never production
        // itself: rehearsal/guard.ts refuses anything that is not localhost).
        // Not part of `vitest run` by default: run it with --project rehearsal.
        extends: true,
        test: {
          name: 'rehearsal',
          include: ['rehearsal/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./rehearsal/guard.ts'],
          fileParallelism: false,
          testTimeout: 300_000,
        },
      },
    ],
  },
})
