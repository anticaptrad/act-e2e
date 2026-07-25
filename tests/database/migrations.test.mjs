// Database migrations and persistence wiring.
//
// The sea-orm migration crate and the service's connection path are invisible
// to every other suite: with no DATABASE_URL configured, readiness always
// reports `database_connected: false` and the schema is never created. These
// tests run a throwaway Postgres so both are exercised for real.
//
// Requires docker and a built migration binary; skips otherwise.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, skipUnlessReady, startPostgres } from '../helpers/postgres.mjs';
import { skipUnlessBuilt, startService } from '../helpers/spawn.mjs';

const skip = (await skipUnlessReady()) || false;

let pg;

before(async () => {
  if (skip) return;
  pg = await startPostgres();
}, { timeout: 180_000 });

after(async () => {
  if (pg) await pg.stop();
});

describe('migrations apply', { skip }, () => {
  test('a fresh database starts with no application tables', async () => {
    const tables = await pg.sql(
      "select count(*) from information_schema.tables where table_schema='public'",
    );
    assert.equal(tables, '0', 'expected an empty schema before migrating');
  });

  test('up creates the schema', async () => {
    const { stdout } = await migrate(pg.url, 'up');
    assert.match(stdout, /Applying migration|has been applied/i);
  });

  test('the events table exists with the expected columns', async () => {
    const columns = await pg.sql(
      "select column_name || ':' || data_type from information_schema.columns " +
        "where table_name='events' order by column_name",
    );
    const found = columns.split('\n').filter(Boolean);
    assert.deepEqual(found, [
      'created_at:timestamp with time zone',
      'id:uuid',
      'payload:jsonb',
      'subject:character varying',
    ]);
  });

  test('id is the primary key', async () => {
    const pk = await pg.sql(
      "select a.attname from pg_index i " +
        'join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) ' +
        "where i.indrelid = 'events'::regclass and i.indisprimary",
    );
    assert.equal(pk, 'id');
  });

  test('created_at defaults to the current timestamp', async () => {
    const def = await pg.sql(
      "select column_default from information_schema.columns " +
        "where table_name='events' and column_name='created_at'",
    );
    assert.match(def, /CURRENT_TIMESTAMP|now\(\)/i);
  });

  test('required columns are NOT NULL', async () => {
    const nullable = await pg.sql(
      "select column_name from information_schema.columns " +
        "where table_name='events' and is_nullable='YES'",
    );
    assert.equal(nullable, '', `unexpected nullable columns: ${nullable}`);
  });

  test('the migration is recorded in the tracking table', async () => {
    const applied = await pg.sql('select version from seaql_migrations order by version');
    assert.match(applied, /m20240101_000001_create_events_table/);
  });

  test('status reports the migration as applied', async () => {
    const { stdout } = await migrate(pg.url, 'status');
    assert.match(stdout, /m20240101_000001_create_events_table/);
    assert.match(stdout, /Applied/i);
  });

  test('re-running up is a no-op, not an error', async () => {
    // Deployments re-run migrations on every rollout; a second run must be safe.
    await migrate(pg.url, 'up');
    const count = await pg.sql('select count(*) from seaql_migrations');
    assert.equal(count, '1', 'migration should not be recorded twice');
  });
});

describe('the schema accepts the rows it was designed for', { skip }, () => {
  test('an event row can be inserted and read back', async () => {
    await pg.sql(
      "insert into events (id, subject, payload) values " +
        "('11111111-1111-1111-1111-111111111111', 'act.events.e2e.insert', '{\"k\":\"v\"}'::jsonb)",
    );
    const row = await pg.sql(
      "select subject || '|' || (payload->>'k') from events " +
        "where id = '11111111-1111-1111-1111-111111111111'",
    );
    assert.equal(row, 'act.events.e2e.insert|v');
  });

  test('created_at is populated automatically', async () => {
    const ts = await pg.sql(
      "select created_at is not null from events " +
        "where id = '11111111-1111-1111-1111-111111111111'",
    );
    assert.equal(ts, 't');
  });

  test('jsonb payloads support structured queries', async () => {
    await pg.sql(
      "insert into events (id, subject, payload) values " +
        "('22222222-2222-2222-2222-222222222222', 'act.events.e2e.nested', " +
        "'{\"outer\":{\"inner\":42}}'::jsonb)",
    );
    const value = await pg.sql(
      "select payload->'outer'->>'inner' from events " +
        "where id = '22222222-2222-2222-2222-222222222222'",
    );
    assert.equal(value, '42');
  });

  test('a duplicate primary key is rejected', async () => {
    await assert.rejects(
      () =>
        pg.sql(
          "insert into events (id, subject, payload) values " +
            "('11111111-1111-1111-1111-111111111111', 'dup', '{}'::jsonb)",
        ),
      'a duplicate id should violate the primary key',
    );
  });

  test('a null subject is rejected', async () => {
    await assert.rejects(
      () =>
        pg.sql(
          "insert into events (id, subject, payload) values " +
            "('33333333-3333-3333-3333-333333333333', null, '{}'::jsonb)",
        ),
      'a null subject should violate NOT NULL',
    );
  });
});

describe('rollback', { skip }, () => {
  test('down removes the schema', async () => {
    await migrate(pg.url, 'down');
    const exists = await pg.sql(
      "select count(*) from information_schema.tables " +
        "where table_schema='public' and table_name='events'",
    );
    assert.equal(exists, '0', 'events table should be gone after down');
  });

  test('up restores it, so the migration is reversible', async () => {
    await migrate(pg.url, 'up');
    const exists = await pg.sql(
      "select count(*) from information_schema.tables " +
        "where table_schema='public' and table_name='events'",
    );
    assert.equal(exists, '1');
  });
});

describe('the service connects to a real database', { skip: skip || skipUnlessBuilt('web') }, () => {
  test('readiness reports the database as connected', async () => {
    // Every other suite runs without DATABASE_URL, so this is the only place
    // the connected branch is exercised at all.
    const svc = await startService('web', {
      DATABASE_URL: pg.url,
      SUPABASE_JWT_SECRET: 'db-suite-secret',
    });
    try {
      const res = await fetch(`${svc.url}/ready`, { signal: AbortSignal.timeout(10_000) });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.database_connected, true);
    } finally {
      await svc.stop();
    }
  });

  test('the connection is logged at startup', async () => {
    const svc = await startService('web', {
      DATABASE_URL: pg.url,
      SUPABASE_JWT_SECRET: 'db-suite-secret',
    });
    try {
      assert.match(svc.logText(), /connected to Postgres/i);
    } finally {
      await svc.stop();
    }
  });

  test('the service still shuts down cleanly with a database attached', async () => {
    const svc = await startService('web', {
      DATABASE_URL: pg.url,
      SUPABASE_JWT_SECRET: 'db-suite-secret',
    });
    const exit = await svc.stop('SIGTERM');
    assert.equal(exit.code, 0);
  });

  test('auth still works with persistence enabled', async () => {
    const svc = await startService('web', {
      DATABASE_URL: pg.url,
      SUPABASE_JWT_SECRET: 'db-suite-secret',
    });
    try {
      const res = await fetch(`${svc.url}/api/me`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(res.status, 401, 'unauthenticated requests must still be denied');
    } finally {
      await svc.stop();
    }
  });
});
