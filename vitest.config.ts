import path from 'node:path';
import { defineConfig } from 'vitest/config';

const electron = path.resolve(process.env.WORKBAR_ELECTRON_DIR ?? path.join(import.meta.dirname, '..', 'workbar-electron'));
const sdk = (f: string) => path.join(electron, 'packages', 'sdk', 'src', f);

export default defineConfig({
  resolve: { alias: { '@workbar/sdk/testing': sdk('testing.ts'), '@workbar/sdk': sdk('index.ts') } },
  // Dates render in local time; pin the zone so golden files are stable.
  test: { include: ['plugins/*/test/**/*.test.ts', 'shared/**/*.test.ts'], env: { TZ: 'America/New_York' } },
});
