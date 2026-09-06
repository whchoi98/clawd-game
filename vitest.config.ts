import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sim': r('./src/sim'),
      '@shared': r('./src/shared'),
      '@client': r('./src/client'),
      '@server': r('./src/server'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // buildApp seeds empty story boards at boot; the suite wants empty boards
    // unless a test opts back in (vi.stubEnv('SEED_BOARDS', '1')).
    env: { SEED_BOARDS: '0' },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // CDK synth tests are slow and memory hungry; keep them off the shared pool.
    pool: 'forks',
  },
});
