import 'reflect-metadata';
import { URLS } from './env.js';

process.env.DATABASE_URL_APP = URLS.app;
process.env.DATABASE_URL_ADMIN = URLS.admin;
