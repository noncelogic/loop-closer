// LC-SENSE-LISTING-BINDINGS acceptance: the scheduled listings read
// (runScheduledListingsRead, what `node dist/portal-read.js` runs) takes its
// target URLs from the graph, never from deploy configuration: exactly the
// source_binding URL of each armed event When that belongs to an open
// directory-listing loop. A listing becomes tracked through intake
// (propose_loop with the When bound to its public page, then accept_loop), so
// a proposed, rejected or suspended loop, a loop of another type, or a
// LISTINGS_DIRECTORY_PAGES left in the environment adds no read. With no such
// binding the run makes no outside read and still records its heartbeat.
//
// Runs on a real, migrated Postgres (tests/kernel/pg-harness.ts) as the app
// role; the outside read goes to a stub fetch this test owns.
// Requires Docker with the Compose plugin (tests/schema/replica.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { PgHarness } from "../../tests/kernel/pg-harness.ts";
import { Kernel, PgGraphStore, type Node } from "../../src/kernel/index.ts";
import {
  ANTHROPIC_LISTINGS_SENSOR,
  LISTING_STATUS_CHANGED,
  runScheduledListingsRead,
} from "../../src/sensors/index.ts";

const harness = new PgHarness("listings-read-targets");
const HEARTBEAT_WHEN_ID = `lc_when_sensor_${ANTHROPIC_LISTINGS_SENSOR.id}_heartbeat`;
const AT = "2026-11-18T08:00:00Z";

before(() => harness.up(), { timeout: 300_000 });
after(() => harness.down(), { timeout: 120_000 });

const joe: Node = {
  id: "lc_who_joe", kind: "who", created_at: AT, status: "active",
  attributes: { who_type: "person", name: "Joe", contact_points: [], external_ids: {} },
};

/** Proposes one listing loop whose event When is bound to listing `slug`'s public page `url`. */
async function proposeListing(kernel: Kernel, store: PgGraphStore, slug: string, url: string, loopType = "directory-listing"): Promise<string> {
  const listing: Node = {
    id: `lc_what_${slug}`, kind: "what", created_at: AT, status: "active",
    attributes: { what_type: "artifact", title: `${slug} listing` },
  };
  const when: Node = {
    id: `lc_when_${slug}_status`, kind: "when", created_at: AT, status: "active",
    attributes: {
      when_type: "event",
      event_type: LISTING_STATUS_CHANGED,
      source_binding: { source: ANTHROPIC_LISTINGS_SENSOR.source_binding.source, mechanism: "poll", config: { subject: slug, url } },
      fired_at: null,
      fire_count: 0,
    },
  };
  const { loop } = await kernel.proposeLoop({
    name: `Chase the ${slug} listing`,
    loop_type: loopType,
    accountable_who_id: joe.id,
    nodes: [(await store.read((tx) => tx.getNode(joe.id))) ? { ref: joe.id } : joe, listing, when],
    edges: [{ from_id: listing.id, to_id: when.id, edge_type: "is_waiting_on" }],
    actor: "agent:cortexplane",
    rationale: "Nothing else is tracking it.",
  });
  return loop.id;
}

function stubFetch() {
  const requests: string[] = [];
  const fetch = async (input: string): Promise<Response> => {
    requests.push(input);
    return new Response("<html><head><title>listing</title></head></html>", { status: 200, headers: { "content-type": "text/html" } });
  };
  return { fetch, requests };
}

async function heartbeats(store: PgGraphStore): Promise<number> {
  const ledger = await store.read((tx) => tx.ledger());
  return ledger.filter((e) => e.event_type === "when_fired" && e.subject_ids.includes(HEARTBEAT_WHEN_ID)).length;
}

test(
  "the scheduled listings read reads exactly the source-binding URLs of armed Whens in open directory-listing loops on the Postgres store",
  { timeout: 120_000 },
  async () => {
    const db = await harness.freshDatabase();
    const store = new PgGraphStore(db.appPool());
    const kernel = new Kernel(store);

    // Tracked through intake: proposed with the public page as the binding, then accepted.
    const connector = await proposeListing(kernel, store, "rove-connector", "https://directory.anthropic.com/listings/rove-connector");
    await kernel.acceptLoop(connector, { acceptor: "joe" });
    const plugin = await proposeListing(kernel, store, "rove-plugin", "https://directory.anthropic.com/listings/rove-plugin");
    await kernel.acceptLoop(plugin, { acceptor: "joe" });
    const chased = await proposeListing(kernel, store, "rove-chased", "https://directory.anthropic.com/listings/rove-chased");
    const accepted = await kernel.acceptLoop(chased, { acceptor: "joe" });
    await kernel.transition(chased, {
      to_state: "chased", actor: "joe", idempotency_key: "chase-rove-chased",
      evidence: { kind: "ledger_event", id: accepted.ledger_event.id },
    });

    // Not tracked: never accepted, rejected at intake, suspended, or another loop type.
    await proposeListing(kernel, store, "only-proposed", "https://directory.anthropic.com/listings/only-proposed");
    const rejected = await proposeListing(kernel, store, "rejected", "https://directory.anthropic.com/listings/rejected");
    await kernel.rejectLoop(rejected, { actor: "joe", reason: "not ours" });
    const suspended = await proposeListing(kernel, store, "suspended", "https://directory.anthropic.com/listings/suspended");
    const opened = await kernel.acceptLoop(suspended, { acceptor: "joe" });
    await kernel.transition(suspended, {
      to_state: "suspended", actor: "joe", idempotency_key: "suspend-listing",
      evidence: { kind: "ledger_event", id: opened.ledger_event.id },
    });
    const other = await proposeListing(kernel, store, "other-type", "https://directory.anthropic.com/listings/other-type", "experiment");
    await kernel.acceptLoop(other, { acceptor: "joe" });

    // Deploy configuration is never a source of listing URLs.
    const saved = process.env["LISTINGS_DIRECTORY_PAGES"];
    process.env["LISTINGS_DIRECTORY_PAGES"] = JSON.stringify({ "from-deploy": "https://directory.anthropic.com/listings/from-deploy" });
    const { fetch, requests } = stubFetch();
    try {
      const report = await runScheduledListingsRead(store, { fetch });
      assert.equal(report.heartbeat, true);
      assert.deepEqual(report.changes.map((c) => c.subject).sort(), ["rove-chased", "rove-connector", "rove-plugin"]);
    } finally {
      if (saved === undefined) delete process.env["LISTINGS_DIRECTORY_PAGES"];
      else process.env["LISTINGS_DIRECTORY_PAGES"] = saved;
    }
    assert.deepEqual(requests.sort(), [
      "https://directory.anthropic.com/listings/rove-chased",
      "https://directory.anthropic.com/listings/rove-connector",
      "https://directory.anthropic.com/listings/rove-plugin",
    ]);
  },
);

test(
  "with no armed listing binding the scheduled listings read makes no outside read and still records its heartbeat",
  { timeout: 120_000 },
  async () => {
    const db = await harness.freshDatabase();
    const store = new PgGraphStore(db.appPool());
    // A proposed-only listing is no binding yet: intake is not finished.
    await proposeListing(new Kernel(store), store, "only-proposed", "https://directory.anthropic.com/listings/only-proposed");

    const { fetch, requests } = stubFetch();
    const before = await heartbeats(store);
    const report = await runScheduledListingsRead(store, { fetch });
    assert.deepEqual(requests, [], "no outside read");
    assert.deepEqual(report.changes, []);
    assert.equal(report.heartbeat, true);
    assert.equal(await heartbeats(store), before + 1, "the run still records its heartbeat");
  },
);
