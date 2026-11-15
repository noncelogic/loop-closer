// LC-M3-BAD-URL acceptance: a request whose target cannot be parsed as a URL
// gets a 400 and the server keeps serving later requests.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer } from "../../src/server.ts";

let server: Server;
let port: number;

before(async () => {
  server = createServer({ apiKeys: new Map([["agent:juno", "test-key-juno"]]) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Sends a raw request line, so the target reaches the server unnormalised (fetch would rewrite it). */
function rawGet(target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (data += chunk));
    socket.on("error", reject);
    // A server that dropped the request would leave the socket open: fail rather than hang.
    socket.setTimeout(5000, () => socket.destroy(new Error(`no response to GET ${target} within 5s`)));
    socket.on("close", () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (!status) return reject(new Error(`no HTTP response: ${JSON.stringify(data)}`));
      resolve({ status: Number(status[1]), body: data.slice(data.indexOf("\r\n\r\n") + 4) });
    });
  });
}

test("an unauthenticated GET //[ returns 400 and a following health request still succeeds", async () => {
  const bad = await rawGet("//[");
  assert.equal(bad.status, 400);
  assert.match(bad.body, /"error":"bad_request"/);

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { service: "loopcloser", status: "ok" });
});
