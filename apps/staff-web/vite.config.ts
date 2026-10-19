import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// In development the app and the API share one origin through this proxy, so the session cookie, CSRF token and Origin check behave exactly as in production.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/v1': { target: process.env.API_URL ?? 'http://localhost:3000', changeOrigin: false } } },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
