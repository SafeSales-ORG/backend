/**
 * Starts a throwaway Postgres for the test run and applies the real
 * migrations to it (so the migrations themselves are under test).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

export default async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safesale-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'safesale',
    password: 'safesale',
    port,
    persistent: false,
    onLog: () => {},
  });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase('safesale_test');

  const url = `postgresql://safesale:safesale@localhost:${port}/safesale_test`;
  process.env.DATABASE_URL = url;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  return async () => {
    fs.rmSync(path.resolve('.test-uploads'), { recursive: true, force: true });
    await pg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  };
}
