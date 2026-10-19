const base = process.env.HOS_TEST_DB ?? 'hos_test';
const host = process.env.HOS_PG_HOST ?? 'localhost:5432';
export const URLS = {
  owner: process.env.TEST_DATABASE_URL_OWNER ?? `postgres://hos_owner:dev@${host}/${base}`,
  app: process.env.TEST_DATABASE_URL_APP ?? `postgres://hos_app:dev@${host}/${base}`,
  admin: process.env.TEST_DATABASE_URL_ADMIN ?? `postgres://hos_admin:dev@${host}/${base}`,
};
