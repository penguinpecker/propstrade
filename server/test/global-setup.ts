// Recreates the test database from scratch and applies the committed migrations, once per test run.
import { runMigrations } from '../src/db/migrate.js';
import { recreateDatabase, testDatabaseUrl } from './db.js';

export default async function setup() {
  const url = testDatabaseUrl();
  await recreateDatabase(url);
  await runMigrations(url);
}
