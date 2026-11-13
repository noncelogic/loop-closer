// LC-M1-T3b: every function the loopcloser migrations define runs with a
// pinned search_path (pg_catalog, public, pg_temp last), so nothing the app
// role creates — a temporary table included — can shadow the protected
// state-machine, ledger or outbox tables a function or trigger reads.
//
// The enumeration covers every function in every non-system schema, so a new
// migration that adds a function without pinning its search_path fails here.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Replica, seedSql } from "./replica.ts";

const db = new Replica("schema-search-path");
const APP = { role: "loopcloser_app" };
const PINNED = "search_path=pg_catalog, public, pg_temp";

before(() => {
  db.up();
  db.migrate();
  db.psql(seedSql);
}, { timeout: 300_000 });
after(() => db.down(), { timeout: 120_000 });

test("every function defined by the loopcloser migrations pins its search_path", { timeout: 60_000 }, () => {
  // Functions and procedures in the loopcloser schemas, excluding system
  // schemas and objects owned by extensions (pgvector's are not ours).
  const rows = db
    .psql(`
      SELECT p.oid::regprocedure::text || '|' || coalesce(array_to_string(p.proconfig, ';'), '')
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
         AND n.nspname NOT LIKE 'pg\\_toast%'
         AND n.nspname NOT LIKE 'pg\\_temp\\_%'
         AND p.prokind IN ('f', 'p')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d
                          WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       ORDER BY 1`)
    .split("\n")
    .filter((r) => r !== "");

  const functions = rows.map((r) => r.slice(0, r.indexOf("|")));
  // Guard against a vacuous pass: the loop state machine trigger must be found.
  assert.ok(
    functions.includes("loops_enforce_state_machine()"),
    `expected loops_enforce_state_machine() among the enumerated functions; have ${functions.join(", ")}`,
  );

  const unpinned = rows
    .map((r) => {
      const [fn, config] = [r.slice(0, r.indexOf("|")), r.slice(r.indexOf("|") + 1)];
      return { fn, config: config.split(";").filter((c) => c.startsWith("search_path=")) };
    })
    .filter(({ config }) => config.length !== 1 || config[0] !== PINNED)
    .map(({ fn, config }) => `${fn} (${config.join(";") || "no search_path"})`);
  assert.deepEqual(unpinned, [], `functions without ${PINNED}:\n  ${unpinned.join("\n  ")}`);
});

test(
  "a temporary table named loop_state_transitions created by the app role does not let a proposed loop move directly to waiting",
  { timeout: 60_000 },
  () => {
    // COND-13-review2: pg_temp is searched first for unqualified relation
    // names in the caller's search_path; the trigger must still read
    // public.loop_state_transitions.
    const err = db.psqlError(
      `CREATE TEMP TABLE loop_state_transitions (from_state text, to_state text, via text);
       INSERT INTO loop_state_transitions VALUES ('proposed', 'waiting', 'transition');
       UPDATE loops SET state = 'waiting' WHERE id = 'lc_loop_1';`,
      APP,
    );
    assert.match(err, /invalid loop transition proposed -> waiting/);

    // Same shadowing attempt with the app role's own search_path putting
    // pg_temp ahead of public explicitly.
    const err2 = db.psqlError(
      `SET search_path = pg_temp, public;
       CREATE TEMP TABLE loop_state_transitions (from_state text, to_state text, via text);
       INSERT INTO loop_state_transitions VALUES ('proposed', 'waiting', 'transition');
       UPDATE public.loops SET state = 'waiting' WHERE id = 'lc_loop_1';`,
      APP,
    );
    assert.match(err2, /invalid loop transition proposed -> waiting/);

    assert.equal(db.psql("select state from loops where id = 'lc_loop_1'"), "proposed");
  },
);
