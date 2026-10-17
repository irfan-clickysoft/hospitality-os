export interface AppConfig { databaseUrlApp: string; port: number }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrlApp = env.DATABASE_URL_APP;
  if (!databaseUrlApp) throw new Error('DATABASE_URL_APP is required');
  return { databaseUrlApp, port: Number(env.PORT ?? 3000) };
}
