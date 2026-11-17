// LC-RUN-PG-CLIENT acceptance: the test helper opens a fresh database on a real
// local Postgres container (the Compose replica, never PGlite or SQLite) and
// migrates it through 0001 and 0002 using the Node Postgres client recorded in
// docs/decisions/postgres-client.md (`pg`). Local credentials only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { PgHarness } from "./pg-harness.ts";

const harness = new PgHarness("pg-harness");

before(() => harness.up(), { timeout: 300_000 });
after(() => harness.down(), { timeout: 120_000 });

test("the helper migrates a fresh local Postgres database through 0001 and 0002", async () => {
  const a = await harness.freshDatabase({ through: "0002" });
  const b = await harness.freshDatabase({ through: "0002" });
  assert.notEqual(a.name, b.name, "each call opens its own database");

  for (const db of [a, b]) {
    const { rows: versions } = await db.pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(versions.map((r) => r.version), ["0001", "0002"]);

    // 0001's tables exist and start empty; 0003's table does not exist yet.
    const { rows: tables } = await db.pool.query<{ t: string | null }>(
      "SELECT to_regclass($1) AS t",
      ["public.ledger_events"],
    );
    assert.equal(tables[0]!.t, "ledger_events");
    assert.equal(Number((await db.pool.query("SELECT count(*) AS n FROM nodes")).rows[0].n), 0);
    const { rows: later } = await db.pool.query<{ t: string | null }>("SELECT to_regclass('public.send_requests') AS t");
    assert.equal(later[0]!.t, null, "migration 0003 is not applied");

    // 0002 pinned the search_path of the schema's functions.
    const { rows: unpinned } = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public' AND p.prokind = 'f'
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
          AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')`,
    );
    assert.equal(Number(unpinned[0]!.n), 0, "every public function has a pinned search_path");
  }

  // An app-role pool reaches the migrated schema with loopcloser_app's grants.
  const app = a.appPool();
  const { rows: who } = await app.query<{ r: string }>("SELECT current_user AS r");
  assert.equal(who[0]!.r, "loopcloser_app");
  assert.equal(Number((await app.query("SELECT count(*) AS n FROM loops")).rows[0].n), 0);
});
