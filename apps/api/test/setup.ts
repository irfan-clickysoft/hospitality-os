import 'reflect-metadata';
import { URLS } from './env.js';

process.env.DATABASE_URL_APP = URLS.app;
process.env.DATABASE_URL_ADMIN = URLS.admin;
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString('base64');
process.env.ALLOWED_ORIGINS = 'https://pms.test';
