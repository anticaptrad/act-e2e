// Disposable Postgres for the migration and persistence suites.
//
// Runs a throwaway container, so these tests exercise the real sea-orm
// migration path and the service's real connection code rather than a stub.
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './spawn.mjs';

const execFile = promisify(execFileCb);
const here = path.dirname(fileURLToPath(import.meta.url));
const SIBLINGS = process.env.ACT_REPOS_PATH ?? path.resolve(here, '../../..');

/** The built sea-orm migration CLI from act-web-server.rs. */
export const MIGRATION_BIN = path.join(SIBLINGS, 'act-web-server.rs/target/debug/migration');

export const hasDocker = async () => {
  try {
    await execFile('docker', ['info'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};

/** Reason to skip, or false when docker and the migration binary are present. */
export async function skipUnlessReady() {
  if (!fs.existsSync(MIGRATION_BIN)) return `migration binary not built: ${MIGRATION_BIN}`;
  if (!(await hasDocker())) return 'docker is not available';
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a Postgres container and wait until it accepts connections.
 * Returns a handle carrying the connection URL and a stop() to clean up.
 */
export async function startPostgres({ name = `act-e2e-pg-${process.pid}` } = {}) {
  const port = await freePort();
  const user = 'e2e';
  const password = 'e2e';
  const db = 'actdb';

  await execFile('docker', ['rm', '-f', name]).catch(() => {});
  await execFile('docker', [
    'run', '-d', '--name', name,
    '-e', `POSTGRES_USER=${user}`,
    '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', `POSTGRES_DB=${db}`,
    '-p', `${port}:5432`,
    'postgres:16-alpine',
  ]);

  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      await execFile('docker', ['exec', name, 'pg_isready', '-U', user, '-d', db], {
        timeout: 5000,
      });
      ready = true;
      break;
    } catch {
      await sleep(500);
    }
  }
  if (!ready) {
    await execFile('docker', ['rm', '-f', name]).catch(() => {});
    throw new Error('postgres did not become ready');
  }

  return {
    name,
    port,
    url: `postgres://${user}:${password}@127.0.0.1:${port}/${db}`,
    /** Run a SQL statement via psql inside the container. */
    async sql(statement) {
      const { stdout } = await execFile('docker', [
        'exec', name, 'psql', '-U', user, '-d', db, '-t', '-A', '-c', statement,
      ]);
      return stdout.trim();
    },
    async stop() {
      await execFile('docker', ['rm', '-f', name]).catch(() => {});
    },
  };
}

/** Run the migration CLI against a database URL. */
export async function migrate(databaseUrl, ...args) {
  return execFile(MIGRATION_BIN, args, {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: databaseUrl },
    timeout: 60_000,
  });
}
