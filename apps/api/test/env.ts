const host = process.env.HOS_PG_HOST ?? 'localhost:5432';
const db = process.env.HOS_API_TEST_DB ?? 'hos_api_test';
export const URLS = {
  owner: process.env.API_TEST_DATABASE_URL_OWNER ?? `postgres://hos_owner:dev@${host}/${db}`,
  app: process.env.API_TEST_DATABASE_URL_APP ?? `postgres://hos_app:dev@${host}/${db}`,
  admin: process.env.API_TEST_DATABASE_URL_ADMIN ?? `postgres://hos_admin:dev@${host}/${db}`,
};
