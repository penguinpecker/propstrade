// Applies committed SQL migrations (../../drizzle). Run on deploy before the new process starts: `npm run migrate`.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client.js';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(databaseUrl: string): Promise<void> {
  const { sql, db } = createDb(databaseUrl);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  await runMigrations(url);
  console.log('migrations applied');
}
