// LC-M2-PORTAL-READER acceptance: the authenticated Anthropic listings portal
// reader, contract-tested against recorded portal responses. No live read: the
// reader's fetch is replaced by a replay of the fixtures under
// fixtures/anthropic-portal/, so CI never touches the portal or a credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newKernel } from "../kernel/fixtures.ts";
import {
  ANTHROPIC_LISTINGS_SENSOR,
  ANTHROPIC_PORTAL_ENV,
  AnthropicPortalReader,
  LISTING_STATUS_CHANGED,
  PortalReadError,
  PortalReadSource,
  SensorFramework,
  loadAnthropicPortalConfig,
} from "../../src/sensors/index.ts";

const PORTAL_URL = "https://portal.example.test/listings";
// A stand-in, never a real credential: it only has to be recognisable in output.
const CREDENTIAL = "sk-portal-test-0f9e8d7c6b5a";

interface Recording {
  request: { method: string; path: string };
  response: { status: number; headers: Record<string, string>; body: unknown };
}

function fixture(name: string): Recording {
  return JSON.parse(readFileSync(new URL(`./fixtures/anthropic-portal/${name}.json`, import.meta.url), "utf8")) as Recording;
}

/**
 * Replays a recorded response. `$CREDENTIAL` in a recorded body stands for the
 * credential the request carried (a portal that echoes it back), so the test
 * proves the reader does not pass such text on.
 */
function replay(recording: Recording) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init });
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const sent = auth.replace(/^Bearer /, "");
    const body = JSON.stringify(recording.response.body).replaceAll("$CREDENTIAL", sent);
    return new Response(body, { status: recording.response.status, headers: recording.response.headers });
  };
  return { fetch, requests };
}

test("the reader parses the recorded portal fixture into listing observations", async () => {
  const recording = fixture("listings-ok");
  const { fetch, requests } = replay(recording);
  const reader = new AnthropicPortalReader({ url: PORTAL_URL, credential: CREDENTIAL, fetch });

  const observations = await reader.read();

  assert.deepEqual(observations, [
    { subject: "rove-connector", status: "in_review", fields: { name: "Rove connector", version: "1.2.0", updated_at: "2026-11-15T18:04:11Z" } },
    { subject: "ledger-mcp", status: "live", fields: { name: "Ledger MCP", version: "0.4.1", updated_at: "2026-11-02T10:22:40Z" } },
  ]);
  // One authenticated GET of the configured portal URL.
  assert.equal(requests.length, 1);
  const [req] = requests;
  assert.ok(req);
  assert.equal(req.url, PORTAL_URL);
  assert.equal(req.init?.method ?? "GET", recording.request.method);
  assert.equal(new Headers(req.init?.headers).get("authorization"), `Bearer ${CREDENTIAL}`);
  // The observations carry the listing state only, never the credential.
  assert.ok(!JSON.stringify(observations).includes(CREDENTIAL));

  // Driven through the sensor, the observations are what the sensor compares.
  const env = newKernel();
  const framework = new SensorFramework(env.kernel, env.store);
  const source = await PortalReadSource.register(framework, env.store, ANTHROPIC_LISTINGS_SENSOR, {
    event_type: LISTING_STATUS_CHANGED,
    read: reader.read,
  });
  const report = await source.poll();
  assert.equal(report.heartbeat, true);
  assert.deepEqual(report.unbound.map((u) => [u.subject, u.from, u.to]), [
    ["rove-connector", null, "in_review"],
    ["ledger-mcp", null, "live"],
  ]);
});

test("an authentication failure from the fixture surfaces as a read failure with no credential text in the error", async () => {
  const { fetch } = replay(fixture("auth-failure"));
  const reader = new AnthropicPortalReader({ url: PORTAL_URL, credential: CREDENTIAL, fetch });

  const err = await reader.read().then(
    () => assert.fail("an authentication failure must not read as an empty portal"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof PortalReadError);
  assert.equal(err.kind, "authentication");
  assert.match(err.message, /authentication/i);
  assert.match(err.message, /401/);
  assert.ok(!err.message.includes(CREDENTIAL));
  assert.ok(!String(err.stack).includes(CREDENTIAL));
  assert.ok(!JSON.stringify(err).includes(CREDENTIAL));

  // Through the sensor: a failed read, no heartbeat, nothing in the ledger mentions the credential.
  const env = newKernel();
  const framework = new SensorFramework(env.kernel, env.store);
  const source = await PortalReadSource.register(framework, env.store, ANTHROPIC_LISTINGS_SENSOR, {
    event_type: LISTING_STATUS_CHANGED,
    read: reader.read,
  });
  const report = await source.poll();
  assert.equal(report.heartbeat, false);
  assert.match(report.error ?? "", /authentication/i);
  assert.ok(!JSON.stringify(report).includes(CREDENTIAL));
  const ledger = await env.store.read((tx) => tx.ledger());
  assert.ok(!JSON.stringify(ledger).includes(CREDENTIAL));
});

test("a malformed portal response is a read failure, not an empty listing set", async () => {
  const fetch = async () => new Response(JSON.stringify({ listings: [{ slug: "x" }] }), { status: 200 });
  const reader = new AnthropicPortalReader({ url: PORTAL_URL, credential: CREDENTIAL, fetch });
  await assert.rejects(reader.read(), (e: unknown) => e instanceof PortalReadError && e.kind === "format");

  const login = async () => new Response("", { status: 302, headers: { location: "https://portal.example.test/login" } });
  const redirected = new AnthropicPortalReader({ url: PORTAL_URL, credential: CREDENTIAL, fetch: login });
  await assert.rejects(redirected.read(), (e: unknown) => e instanceof PortalReadError && e.kind === "authentication");
});

test("the credential comes from runtime configuration, a mounted secret file", () => {
  const dir = mkdtempSync(join(tmpdir(), "portal-cred-"));
  const file = join(dir, "credential");
  writeFileSync(file, `${CREDENTIAL}\n`);

  const config = loadAnthropicPortalConfig({
    [ANTHROPIC_PORTAL_ENV.url]: PORTAL_URL,
    [ANTHROPIC_PORTAL_ENV.credentialFile]: file,
  });
  assert.deepEqual(config, { url: PORTAL_URL, credential: CREDENTIAL });

  // Unconfigured: the reader is simply not available.
  assert.equal(loadAnthropicPortalConfig({}), undefined);
  // Half-configured or an empty secret is an error that names the variable, not the secret.
  writeFileSync(file, "\n");
  assert.throws(
    () => loadAnthropicPortalConfig({ [ANTHROPIC_PORTAL_ENV.url]: PORTAL_URL, [ANTHROPIC_PORTAL_ENV.credentialFile]: file }),
    /empty/,
  );
  assert.throws(() => loadAnthropicPortalConfig({ [ANTHROPIC_PORTAL_ENV.url]: PORTAL_URL }), new RegExp(ANTHROPIC_PORTAL_ENV.credentialFile));
});
