// LC-SENSE-PORTAL-ENTRY acceptance: the build emits the scheduled portal-read
// entrypoint (`node dist/portal-read.js`). Each invocation runs one
// PortalReadSource poll against PgGraphStore at DATABASE_URL, comparing with
// the listing status recorded by earlier invocations. A failed read exits
// non-zero without a heartbeat, so a stale sensor stays distinct from a quiet
// world.
//
// The listing is tracked through intake: its When's source binding names the
// listing's public page (LC-SENSE-LISTING-BINDINGS), served by a stub directory
// this test owns. The entrypoint takes no listing URL from its environment.
//
// Requires Docker with the Compose plugin (tests/schema/replica.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import pg from "pg";
import { Replica, repoRoot } from "../schema/replica.ts";
import { buildEntrypoints, type EntrypointBuild } from "../support/entrypoint-build.ts";
import { Kernel, PgGraphStore, type Node } from "../../src/kernel/index.ts";
import { ANTHROPIC_LISTINGS_SENSOR, LISTING_STATUS_CHANGED } from "../../src/sensors/index.ts";

const ENTRYPOINT = "portal-read.js";

// A private build output, not the shared `dist/` (tests/support/entrypoint-build.ts).
let build: EntrypointBuild | undefined;
const SUBJECT = "rove-connector";
const WHEN_ID = "lc_when_listing_status_changed";
const HEARTBEAT_WHEN_ID = `lc_when_sensor_${ANTHROPIC_LISTINGS_SENSOR.id}_heartbeat`;

const db = new Replica("portal-entrypoint");

/** The stub public directory: the listing page answers with `pageStatus`. */
let pageStatus = 404;
const directory = http.createServer((_req, res) => {
  res.writeHead(pageStatus, { "content-type": "text/html" });
  res.end(pageStatus === 200 ? "<html><head><title>Rove connector</title></head></html>" : "");
});

before(
  async () => {
    build = await buildEntrypoints("portal-entrypoint");
    db.up();
    db.migrate();
    await new Promise<void>((resolve, reject) => {
      directory.once("error", reject);
      directory.listen(0, "127.0.0.1", resolve);
    });
    const { port } = directory.address() as { port: number };
    await bindListingWhen(`http://127.0.0.1:${port}/listings/${SUBJECT}`);
  },
  { timeout: 300_000 },
);
after(
  async () => {
    try {
      await new Promise<void>((resolve) => directory.close(() => resolve()));
      db.down();
    } finally {
      build?.remove();
    }
  },
  { timeout: 120_000 },
);

/** A loop waiting on the listing, through a When bound to that one listing. */
async function bindListingWhen(page: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: db.databaseUrl() });
  try {
    const kernel = new Kernel(new PgGraphStore(pool));
    const at = "2026-11-10T08:00:00Z";
    const joe: Node = {
      id: "lc_who_joe", kind: "who", created_at: at, status: "active",
      attributes: { who_type: "person", name: "Joe", contact_points: [], external_ids: {} },
    };
    const listing: Node = {
      id: "lc_what_rove_connector_listing", kind: "what", created_at: at, status: "active",
      attributes: { what_type: "artifact", title: "Rove connector listing" },
    };
    const when: Node = {
      id: WHEN_ID, kind: "when", created_at: at, status: "active",
      attributes: {
        when_type: "event",
        event_type: LISTING_STATUS_CHANGED,
        source_binding: { source: ANTHROPIC_LISTINGS_SENSOR.source_binding.source, mechanism: "poll", config: { subject: SUBJECT, url: page } },
        fired_at: null,
        fire_count: 0,
      },
    };
    const { loop } = await kernel.proposeLoop({
      name: "Chase the Rove connector listing",
      loop_type: "directory-listing",
      accountable_who_id: joe.id,
      nodes: [joe, listing, when],
      edges: [{ from_id: listing.id, to_id: when.id, edge_type: "is_waiting_on" }],
      actor: "agent:juno",
      rationale: "Nothing else is tracking it.",
    });
    await kernel.acceptLoop(loop.id, { acceptor: "joe" });
  } finally {
    await pool.end();
  }
}

/** The entrypoint inside this file's private build. */
function entrypoint(): string {
  assert.ok(build, "the entrypoint build must have completed");
  return build.path(ENTRYPOINT);
}

/** Runs the built entrypoint asynchronously, so the stub directory keeps serving. */
async function invoke(): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: db.databaseUrl() };
  const child = spawn("node", [entrypoint()], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  return { status, stdout, stderr };
}

/** Every status-change firing recorded on the listing's When, oldest first, as `from>to`. */
function listingFirings(): string[] {
  return db
    .psql(`SELECT coalesce(payload->'event_payload'->>'from', 'null') || '>' || (payload->'event_payload'->>'to')
             FROM ledger_events
            WHERE event_type = 'when_fired' AND '${WHEN_ID}' = ANY(subject_ids)
            ORDER BY seq`)
    .split("\n")
    .filter(Boolean);
}

function heartbeats(): number {
  return Number(db.psql(`SELECT count(*) FROM ledger_events WHERE event_type = 'when_fired' AND '${HEARTBEAT_WHEN_ID}' = ANY(subject_ids)`));
}

test("the build emits the portal-read entrypoint", () => {
  assert.ok(existsSync(entrypoint()), `npm run build must emit ${ENTRYPOINT}`);
});

test("a listing whose status changed since the previous invocation records one fire_event on its bound When in Postgres", { timeout: 120_000 }, async () => {
  pageStatus = 404;
  const first = await invoke();
  assert.equal(first.status, 0, `first invocation failed:\n${first.stderr}`);
  assert.deepEqual(listingFirings(), ["null>not_listed"]);

  // The listing went live between invocations: the second, a fresh process,
  // compares with what the first stored and records exactly the change.
  pageStatus = 200;
  const second = await invoke();
  assert.equal(second.status, 0, `second invocation failed:\n${second.stderr}`);
  assert.deepEqual(listingFirings(), ["null>not_listed", "not_listed>live"]);
  const actor = db.psql(`SELECT actor FROM ledger_events WHERE '${WHEN_ID}' = ANY(subject_ids) ORDER BY seq DESC LIMIT 1`);
  assert.equal(actor, `sensor:${ANTHROPIC_LISTINGS_SENSOR.id}`);
  assert.equal(db.psql(`SELECT attributes->>'fire_count' FROM nodes WHERE id = '${WHEN_ID}'`), "2");
});

test("a second invocation over an unchanged read records no event and records a heartbeat", { timeout: 120_000 }, async () => {
  pageStatus = 200;
  const primed = await invoke();
  assert.equal(primed.status, 0, `priming invocation failed:\n${primed.stderr}`);
  const firings = listingFirings();
  const beats = heartbeats();

  const again = await invoke();
  assert.equal(again.status, 0, `unchanged invocation failed:\n${again.stderr}`);
  assert.deepEqual(listingFirings(), firings, "an unchanged read must record no status change");
  assert.equal(heartbeats(), beats + 1, "a quiet world still heartbeats");
});

test("an invocation whose read fails exits non-zero and records no heartbeat", { timeout: 120_000 }, async () => {
  const firings = listingFirings();
  const beats = heartbeats();
  const firedAt = db.psql(`SELECT coalesce(attributes->>'fired_at', '') FROM nodes WHERE id = '${HEARTBEAT_WHEN_ID}'`);

  pageStatus = 503;
  const failed = await invoke();
  assert.notEqual(failed.status, null, `the invocation must exit, not hang:\n${failed.stderr}`);
  assert.notEqual(failed.status, 0, "a failed read must fail the invocation");
  assert.match(failed.stderr, /portal read failed/);
  assert.match(failed.stderr, /HTTP 503/);
  assert.equal(heartbeats(), beats, "a failed read must not heartbeat");
  assert.equal(db.psql(`SELECT coalesce(attributes->>'fired_at', '') FROM nodes WHERE id = '${HEARTBEAT_WHEN_ID}'`), firedAt);
  assert.deepEqual(listingFirings(), firings);
});
