// LC-M2-T3 acceptance: the first two sensor sources. The calendar source (time
// itself) and a scheduled portal-read source (the Anthropic listings check: no
// API exists, so the sensor is a scheduled read) each drive real fire_events
// through the sensor framework into the graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, joe, newKernel } from "../kernel/fixtures.ts";
import type { Node } from "../../src/kernel/index.ts";
import {
  ANTHROPIC_LISTINGS_SENSOR,
  CalendarSource,
  LISTING_STATUS_CHANGED,
  ListingReadError,
  NOT_LISTED,
  PUBLIC_LISTING_ENV,
  PortalReadSource,
  PublicListingReader,
  SensorFramework,
  loadPublicListingConfig,
  type PortalObservation,
} from "../../src/sensors/index.ts";

const START = Date.parse("2026-11-10T09:00:00Z");

function clock(env: ReturnType<typeof newKernel>) {
  let elapsed = 0;
  return {
    now: () => new Date(START + elapsed * 1000),
    advance: (seconds: number) => {
      elapsed += seconds;
      env.tick(seconds);
    },
  };
}

const followUpDue: Node = {
  id: "lc_when_follow_up_due",
  kind: "when",
  created_at: "2026-11-10T08:00:00Z",
  status: "active",
  attributes: {
    when_type: "calendar",
    schedule: { rrule: "FREQ=DAILY" },
    timezone: "America/New_York",
    next_fire_at: "2026-11-10T09:30:00.000Z",
  },
};

const followUp: Node = {
  id: "lc_what_follow_up",
  kind: "what",
  created_at: "2026-11-10T08:00:00Z",
  status: "active",
  attributes: { what_type: "action", title: "Follow up on the paper's authors" },
};

const listingStatusChanged: Node = {
  id: "lc_when_listing_status_changed",
  kind: "when",
  created_at: "2026-11-10T08:00:00Z",
  status: "active",
  attributes: {
    when_type: "event",
    event_type: LISTING_STATUS_CHANGED,
    source_binding: { source: ANTHROPIC_LISTINGS_SENSOR.source_binding.source, mechanism: "poll", config: { subject: "rove-connector" } },
    fired_at: null,
    fire_count: 0,
  },
};

const listing: Node = {
  id: "lc_what_rove_connector_listing",
  kind: "what",
  created_at: "2026-11-10T08:00:00Z",
  status: "active",
  attributes: { what_type: "artifact", title: "Rove connector listing" },
};

async function waitingLoop(env: ReturnType<typeof newKernel>, what: Node, when: Node, key: string) {
  const { loop } = await env.kernel.proposeLoop({
    name: `Chase ${what.attributes["title"]}`,
    loop_type: "directory-listing",
    accountable_who_id: joe.id,
    nodes: [joe, what, when],
    edges: [{ from_id: what.id, to_id: when.id, edge_type: "is_waiting_on" }],
    actor: "agent:juno",
    rationale: "Nothing else is tracking it.",
  });
  await env.kernel.acceptLoop(loop.id, { acceptor: "joe" });
  return {
    loopId: loop.id,
    wait: () =>
      env.kernel.transition(loop.id, {
        to_state: "waiting",
        actor: "agent:juno",
        evidence: { kind: "communication", id: `lc_comm_${key}` },
        idempotency_key: `wait-${key}`,
      }),
  };
}

test("calendar and portal-read sources each drive a fire_event through the framework", async (t) => {
  await t.test("calendar source", async () => {
    const env = newKernel();
    const { now, advance } = clock(env);
    const { loopId, wait } = await waitingLoop(env, followUp, followUpDue, "cal");
    await wait();
    const framework = new SensorFramework(env.kernel, env.store, { now });
    const calendar = await CalendarSource.register(framework, env.store, { now });
    assert.equal(calendar.sensor.actor, "sensor:calendar");

    // Not yet due: nothing fires, but the sensor still heartbeats (a quiet world, not a dead sensor).
    advance(10 * 60);
    const quiet = await calendar.poll();
    assert.deepEqual(quiet.fired, []);
    assert.equal(quiet.heartbeat, true);
    assert.equal((await env.kernel.getLoop(loopId)).state, "waiting");

    // Past due: the calendar When fires through the framework and the waiting loop re-opens.
    advance(21 * 60);
    const report = await calendar.poll();
    assert.equal(report.fired.length, 1);
    const [fired] = report.fired;
    assert.ok(fired);
    assert.equal(fired.when_id, followUpDue.id);
    assert.equal(fired.scheduled_for, "2026-11-10T09:30:00.000Z");
    assert.equal(fired.next_fire_at, "2026-11-11T09:30:00.000Z");
    assert.equal(fired.applied, true);
    const event = (await env.store.read((tx) => tx.ledger())).find((e) => e.id === fired.event_id);
    assert.ok(event);
    assertValid("ledger-event", event);
    assert.equal(event.event_type, "when_fired");
    assert.equal(event.actor, "sensor:calendar");
    assert.deepEqual(event.subject_ids, [followUpDue.id, loopId]);
    assert.deepEqual(event.payload["event_payload"], {
      scheduled_for: "2026-11-10T09:30:00.000Z",
      next_fire_at: "2026-11-11T09:30:00.000Z",
      missed_occurrences: 0,
    });
    assert.equal((await env.kernel.getLoop(loopId)).state, "open");
    const advanced = await env.store.read((tx) => tx.getNode(followUpDue.id));
    assert.ok(advanced);
    assertValid("node", advanced);
    assert.equal(advanced.attributes["next_fire_at"], "2026-11-11T09:30:00.000Z");

    // The slot fires once: polling again before the next occurrence is quiet.
    advance(60);
    assert.deepEqual((await calendar.poll()).fired, []);
    const beat = await env.store.read((tx) => tx.getNode(calendar.sensor.heartbeat_when_id));
    assert.equal(beat?.attributes["fired_at"], now().toISOString());
  });

  await t.test("portal-read source (Anthropic listings)", async () => {
    const env = newKernel();
    const { now, advance } = clock(env);
    const { loopId, wait } = await waitingLoop(env, listing, listingStatusChanged, "listing");

    // The portal has no API: the reader is a scheduled read of the page.
    let page: PortalObservation[] = [{ subject: "rove-connector", status: "in_review", fields: { version: "1.2.0" } }];
    let reads = 0;
    const framework = new SensorFramework(env.kernel, env.store, { now });
    const listings = await PortalReadSource.register(framework, env.store, ANTHROPIC_LISTINGS_SENSOR, {
      event_type: LISTING_STATUS_CHANGED,
      read: async () => {
        reads++;
        return page;
      },
    });
    assert.equal(listings.sensor.actor, "sensor:anthropic_listings");
    assert.equal(listings.sensor.source_binding.mechanism, "poll");

    // First read: the status is new to the graph, so it is recorded as a fire_event.
    const first = await listings.poll();
    assert.equal(reads, 1);
    assert.equal(first.heartbeat, true);
    assert.deepEqual(first.changes.map((c) => [c.subject, c.from, c.to, c.applied]), [["rove-connector", null, "in_review", true]]);

    await wait();
    // Unchanged on the next scheduled read: no event, only a heartbeat.
    advance(6 * 3600);
    const unchanged = await listings.poll();
    assert.deepEqual(unchanged.changes, []);
    assert.equal(unchanged.heartbeat, true);
    assert.equal((await env.kernel.getLoop(loopId)).state, "waiting");

    // The listing goes live: a fire_event through the framework re-opens the waiting loop.
    advance(6 * 3600);
    page = [{ subject: "rove-connector", status: "live", fields: { version: "1.2.0" } }];
    const live = await listings.poll();
    assert.equal(live.changes.length, 1);
    const [change] = live.changes;
    assert.ok(change);
    assert.equal(change.from, "in_review");
    assert.equal(change.to, "live");
    const event = (await env.store.read((tx) => tx.ledger())).find((e) => e.id === change.event_id);
    assert.ok(event);
    assertValid("ledger-event", event);
    assert.equal(event.event_type, "when_fired");
    assert.equal(event.actor, "sensor:anthropic_listings");
    assert.deepEqual(event.subject_ids, [listingStatusChanged.id, loopId]);
    assert.equal(event.payload["event_type"], LISTING_STATUS_CHANGED);
    assert.equal(event.payload["source"], "anthropic_listings");
    assert.deepEqual(event.payload["event_payload"], {
      subject: "rove-connector",
      from: "in_review",
      to: "live",
      fields: { version: "1.2.0" },
    });
    assert.equal((await env.kernel.getLoop(loopId)).state, "open");
    const when = await env.store.read((tx) => tx.getNode(listingStatusChanged.id));
    assert.equal(when?.attributes["fire_count"], 2);

    // A failed read is not a heartbeat: the sensor goes silent and its miss is recorded.
    advance(6 * 3600);
    const failing = await PortalReadSource.register(framework, env.store, ANTHROPIC_LISTINGS_SENSOR, {
      event_type: LISTING_STATUS_CHANGED,
      read: async () => {
        throw new Error("portal login page changed");
      },
    });
    const failed = await failing.poll();
    assert.equal(failed.heartbeat, false);
    assert.match(failed.error ?? "", /portal login page changed/);
    advance(ANTHROPIC_LISTINGS_SENSOR.heartbeat.interval_seconds + (ANTHROPIC_LISTINGS_SENSOR.heartbeat.grace_seconds ?? 0));
    const missed = await framework.checkHeartbeats();
    assert.deepEqual(missed.map((m) => m.sensor_id), ["anthropic_listings"]);
  });
});

<<<<<<< HEAD
// LC-SENSE-LISTING-ROUTE: each directory listing is its own loop (SPEC B2.3), so
// a When names the listing it watches in source_binding.config.subject and a
// change to one listing fires only that listing's When.
function listingWhen(id: string, slug: string): Node {
  return {
    ...listingStatusChanged,
    id,
    attributes: {
      ...listingStatusChanged.attributes,
      source_binding: { source: ANTHROPIC_LISTINGS_SENSOR.source_binding.source, mechanism: "poll", config: { subject: slug } },
    },
  };
}

const connectorWhen = listingWhen("lc_when_rove_connector_status", "rove-connector");
const pluginWhen = listingWhen("lc_when_rove_plugin_status", "rove-plugin");
const pluginListing: Node = { ...listing, id: "lc_what_rove_plugin_listing", attributes: { what_type: "artifact", title: "Rove plugin listing" } };

async function twoListings() {
  const env = newKernel();
  const { now, advance } = clock(env);
  const connector = await waitingLoop(env, listing, connectorWhen, "connector");
  const plugin = await waitingLoop(env, pluginListing, pluginWhen, "plugin");
  let page: PortalObservation[] = [];
  const framework = new SensorFramework(env.kernel, env.store, { now });
  const listings = await PortalReadSource.register(framework, env.store, ANTHROPIC_LISTINGS_SENSOR, {
    event_type: LISTING_STATUS_CHANGED,
    read: async () => page,
  });
  return { env, advance, connector, plugin, listings, setPage: (p: PortalObservation[]) => (page = p) };
}

const fireCount = async (env: ReturnType<typeof newKernel>, id: string) =>
  (await env.store.read((tx) => tx.getNode(id)))?.attributes["fire_count"];

test("with two listings bound to two Whens, a status change on one listing fires only its own When", async () => {
  const { env, advance, connector, plugin, listings, setPage } = await twoListings();
  setPage([
    { subject: "rove-connector", status: "in_review" },
    { subject: "rove-plugin", status: "scanning" },
  ]);
  const first = await listings.poll();
  assert.deepEqual(first.changes.map((c) => [c.subject, c.to]), [["rove-connector", "in_review"], ["rove-plugin", "scanning"]]);
  assert.deepEqual(first.unbound, []);
  await connector.wait();
  await plugin.wait();

  advance(6 * 3600);
  setPage([
    { subject: "rove-connector", status: "live" },
    { subject: "rove-plugin", status: "scanning" },
  ]);
  const live = await listings.poll();
  assert.equal(live.changes.length, 1);
  const [change] = live.changes;
  assert.ok(change);
  assert.equal(change.subject, "rove-connector");
  const event = (await env.store.read((tx) => tx.ledger())).find((e) => e.id === change.event_id);
  assert.ok(event);
  assertValid("ledger-event", event);
  assert.deepEqual(event.payload["when_ids"], [connectorWhen.id]);
  assert.deepEqual(event.subject_ids, [connectorWhen.id, connector.loopId]);
  assert.equal(await fireCount(env, connectorWhen.id), 2);
  assert.equal(await fireCount(env, pluginWhen.id), 1);
  assert.equal((await env.kernel.getLoop(connector.loopId)).state, "open");
  assert.equal((await env.kernel.getLoop(plugin.loopId)).state, "waiting");
});

test("a change on a listing no When is bound to is reported unbound and fires nothing", async () => {
  const { env, plugin, connector, listings, setPage } = await twoListings();
  // A listing When that names no listing at all must not hear this change either.
  const subjectless: Node = {
    ...listingStatusChanged,
    id: "lc_when_listing_no_subject",
    attributes: {
      ...listingStatusChanged.attributes,
      source_binding: { source: ANTHROPIC_LISTINGS_SENSOR.source_binding.source, mechanism: "poll" },
    },
  };
  const skillListing: Node = { ...listing, id: "lc_what_rove_skill_listing", attributes: { what_type: "artifact", title: "Rove skill listing" } };
  const unnamed = await waitingLoop(env, skillListing, subjectless, "unnamed");
  await connector.wait();
  await plugin.wait();
  await unnamed.wait();
  const before = (await env.store.read((tx) => tx.ledger())).length;
  setPage([{ subject: "rove-skill", status: "scanning" }]);
  const report = await listings.poll();
  assert.deepEqual(report.changes, []);
  assert.deepEqual(report.unbound, [{ subject: "rove-skill", from: null, to: "scanning" }]);
  assert.equal(report.heartbeat, true);
  const after = await env.store.read((tx) => tx.ledger());
  assert.deepEqual(after.slice(before).filter((e) => e.event_type === "when_fired" && e.payload["event_type"] === LISTING_STATUS_CHANGED), []);
  assert.equal(await fireCount(env, connectorWhen.id), 0);
  assert.equal(await fireCount(env, pluginWhen.id), 0);
  assert.equal(await fireCount(env, subjectless.id), 0);
  assert.equal((await env.kernel.getLoop(connector.loopId)).state, "waiting");
  assert.equal((await env.kernel.getLoop(plugin.loopId)).state, "waiting");
  assert.equal((await env.kernel.getLoop(unnamed.loopId)).state, "waiting");
=======
// LC-SENSE-PUBLIC-LISTING acceptance: the listings sensor reads each tracked
// listing's public directory page (URL per listing from configuration) with no
// credential. The page fetch is replaced by a stub, so CI never reads the live
// directory.
const ROVE_PAGE = "https://directory.example.test/connectors/rove-connector";
const PLUGIN_PAGE = "https://directory.example.test/plugins/rove-plugin";

const ROVE_HTML = `<!doctype html>
<html><head>
<title>Rove connector | Directory</title>
<meta property="og:title" content="Rove connector">
<meta name="description" content="Plan trips &amp; share them with Rove.">
<link rel="canonical" href="${ROVE_PAGE}">
</head><body><h1>Rove connector</h1></body></html>`;

interface SentRequest {
  url: string;
  headers: Headers;
  init: RequestInit | undefined;
}

function directory(pages: Record<string, () => Response | Promise<Response>>) {
  const requests: SentRequest[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    requests.push({ url: input, headers: new Headers(init?.headers), init });
    const page = pages[input];
    if (!page) return new Response("not found", { status: 404 });
    return page();
  };
  return { fetch, requests };
}

const html = (body: string) => () => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });

test("a public listing page read records status and metadata fields with no credential configured", async () => {
  // Configuration is a URL per listing and nothing else: there is no credential to configure.
  const config = loadPublicListingConfig({ [PUBLIC_LISTING_ENV.pages]: JSON.stringify({ "rove-connector": ROVE_PAGE }) });
  assert.deepEqual(config, { listings: [{ subject: "rove-connector", url: ROVE_PAGE }] });

  const { fetch, requests } = directory({ [ROVE_PAGE]: html(ROVE_HTML) });
  const reader = new PublicListingReader({ ...config!, fetch });

  const observations = await reader.read();
  assert.deepEqual(observations, [
    {
      subject: "rove-connector",
      status: "live",
      fields: { name: "Rove connector", description: "Plan trips & share them with Rove.", url: ROVE_PAGE },
    },
  ]);
  // One anonymous GET of the configured public page: no credential, no cookie, no login.
  assert.equal(requests.length, 1);
  const [req] = requests;
  assert.ok(req);
  assert.equal(req.url, ROVE_PAGE);
  assert.equal(req.init?.method ?? "GET", "GET");
  assert.equal(req.headers.get("authorization"), null);
  assert.equal(req.headers.get("cookie"), null);
  assert.equal(req.init?.credentials, "omit");

  // Through the sensor: the status and public fields land in the ledger as a fire_event.
  const env = newKernel();
  const { loopId, wait } = await waitingLoop(env, listing, listingStatusChanged, "public");
  await wait();
  const framework = new SensorFramework(env.kernel, env.store);
  const source = await PortalReadSource.register(framework, env.store, ANTHROPIC_LISTINGS_SENSOR, {
    event_type: LISTING_STATUS_CHANGED,
    read: reader.read,
  });
  const report = await source.poll();
  assert.equal(report.heartbeat, true);
  assert.equal(report.changes.length, 1);
  const [change] = report.changes;
  assert.ok(change);
  const event = (await env.store.read((tx) => tx.ledger())).find((e) => e.id === change.event_id);
  assert.ok(event);
  assertValid("ledger-event", event);
  assert.deepEqual(event.payload["event_payload"], {
    subject: "rove-connector",
    from: null,
    to: "live",
    fields: { name: "Rove connector", description: "Plan trips & share them with Rove.", url: ROVE_PAGE },
  });
  assert.equal((await env.kernel.getLoop(loopId)).state, "open");
});

test("a listing absent from the public directory reads as not-listed", async () => {
  const { fetch } = directory({ [ROVE_PAGE]: html(ROVE_HTML) });
  const reader = new PublicListingReader({
    listings: [
      { subject: "rove-connector", url: ROVE_PAGE },
      // Filed but still in review: its public page does not exist yet.
      { subject: "rove-plugin", url: PLUGIN_PAGE },
    ],
    fetch,
  });

  const observations = await reader.read();
  assert.deepEqual(
    observations.map((o) => [o.subject, o.status]),
    [
      ["rove-connector", "live"],
      ["rove-plugin", NOT_LISTED],
    ],
  );

  // Not-listed is a status, not a failure: the sensor records it and heartbeats.
  const env = newKernel();
  const framework = new SensorFramework(env.kernel, env.store);
  const source = await PortalReadSource.register(framework, env.store, ANTHROPIC_LISTINGS_SENSOR, {
    event_type: LISTING_STATUS_CHANGED,
    read: reader.read,
  });
  const report = await source.poll();
  assert.equal(report.heartbeat, true);
  assert.equal(report.error, undefined);
  assert.deepEqual(report.unbound.map((u) => [u.subject, u.from, u.to]), [
    ["rove-connector", null, "live"],
    ["rove-plugin", null, NOT_LISTED],
  ]);
});

test("an unreachable directory page fails the read without a heartbeat", async (t) => {
  const failures: Record<string, () => Response | Promise<Response>> = {
    "network error": () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND directory.example.test");
    },
    "server error": () => new Response("upstream down", { status: 503 }),
  };
  for (const [name, page] of Object.entries(failures)) {
    await t.test(name, async () => {
      const env = newKernel();
      const { now, advance } = clock(env);
      const { fetch } = directory({ [ROVE_PAGE]: html(ROVE_HTML), [PLUGIN_PAGE]: page });
      const reader = new PublicListingReader({
        listings: [
          { subject: "rove-connector", url: ROVE_PAGE },
          { subject: "rove-plugin", url: PLUGIN_PAGE },
        ],
        fetch,
      });
      await assert.rejects(reader.read(), (e: unknown) => e instanceof ListingReadError && e.message.includes("rove-plugin"));

      const framework = new SensorFramework(env.kernel, env.store, { now });
      const source = await PortalReadSource.register(framework, env.store, ANTHROPIC_LISTINGS_SENSOR, {
        event_type: LISTING_STATUS_CHANGED,
        read: reader.read,
      });
      const report = await source.poll();
      assert.equal(report.heartbeat, false);
      assert.match(report.error ?? "", /rove-plugin/);
      // An unreachable page is not read as not-listed: nothing is recorded for either listing.
      assert.deepEqual(report.changes, []);
      assert.deepEqual(report.unbound, []);
      advance(ANTHROPIC_LISTINGS_SENSOR.heartbeat.interval_seconds + (ANTHROPIC_LISTINGS_SENSOR.heartbeat.grace_seconds ?? 0) + 1);
      const missed = await framework.checkHeartbeats();
      assert.deepEqual(missed.map((m) => m.sensor_id), ["anthropic_listings"]);
    });
  }
>>>>>>> origin/main
});
