import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { testTimeout: 30000, globalSetup: ['./test/global-setup.ts'], fileParallelism: false, setupFiles: ['./test/setup.ts'] } });
