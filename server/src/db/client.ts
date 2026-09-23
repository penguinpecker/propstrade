import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, connect_timeout: 10, onnotice: () => {} });
  return { sql, db: drizzle(sql, { schema }) };
}

export type Sql = ReturnType<typeof createDb>['sql'];
export type Db = ReturnType<typeof createDb>['db'];
