import postgres from 'postgres';

/** A dedicated, disposable database (it is dropped and recreated), e.g. postgres://…/props_server_test. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Set TEST_DATABASE_URL to a disposable Postgres database (it is dropped and recreated)');
  return url;
}

export async function recreateDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z0-9_]+_test[a-z0-9_]*$/.test(name)) throw new Error(`Refusing to recreate "${name}": test database names contain _test`);
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`drop database if exists "${name}" with (force)`);
    await sql.unsafe(`create database "${name}"`);
  } finally {
    await sql.end();
  }
}
