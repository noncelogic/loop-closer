#!/usr/bin/env node
// Estate registry inputs for the loopcloser estate image (LC-EST-IMAGE-PUBLISH).
//
// The registry push credential is loop-closer's own, least privilege, custodied
// in OpenBao at kv/loop-closer/registry-push (Rule:
// policies/placement-defaults.yaml#credentials). It never lives in repository
// secrets. The registry host is the repository variable ESTATE_REGISTRY.
//
//   node estate-registry-credential.mjs check   # pull-request dry run (ci.yml estate-image-inputs)
//   node estate-registry-credential.mjs login   # main publish (estate-image.yml publish)
//
// Both modes validate the same inputs: ESTATE_REGISTRY and OPENBAO_ADDR are
// set, the job can mint a GitHub OIDC token (permissions id-token: write), and
// OpenBao accepts it through JWT auth.
//   check: logs in as role loop-closer-registry-push-check, which may read only
//          the credential's KV metadata, the publish role's JWT configuration
//          and that role's ACL policies. It proves a current, undeleted version
//          exists and that the publish role's policies grant `read` on
//          kv/data/loop-closer/registry-push (and none denies it), so a
//          credential the publish could not read fails the dry run. It never
//          reads the credential itself.
//   login: logs in as role loop-closer-registry-push (bound to main), reads the
//          credential's `username` and `password`, masks them and pipes the
//          password to `docker login --password-stdin`. Nothing is written to
//          disk by this script, echoed or passed as an argument.
// Any missing or unreachable input fails with an ::error:: naming it. Transient
// failures (network, HTTP 429/5xx) are retried a bounded number of times.
import { spawn } from "node:child_process";

const CREDENTIAL_PATH = "kv/loop-closer/registry-push";
const KV_MOUNT = "kv";
const KV_KEY = "loop-closer/registry-push";
const AUTH_MOUNT = "jwt";
const AUDIENCE = "openbao";
const ROLES = { check: "loop-closer-registry-push-check", login: "loop-closer-registry-push" };
const ATTEMPTS = 3;
const RETRY_DELAY_MS = Number(process.env.OPENBAO_RETRY_DELAY_MS ?? 5000);
const REQUEST_TIMEOUT_MS = 20_000;

class InputError extends Error {}

function fail(message) {
  console.log(`::error::${message}`);
  process.exitCode = 1;
}

/** fetch with a per-request timeout and bounded retries on transient failures. */
async function request(what, url, init) {
  let last = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) return await res.json();
      const body = (await res.text()).slice(0, 200);
      last = `HTTP ${res.status}${body ? `: ${body}` : ""}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (err) {
      last = String(err?.cause?.message ?? err?.message ?? err);
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  throw new InputError(`${what} failed: ${last}`);
}

async function oidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) {
    throw new InputError("GitHub OIDC token is unavailable: the job needs `permissions: id-token: write`");
  }
  const u = new URL(url);
  u.searchParams.set("audience", AUDIENCE);
  const body = await request("GitHub OIDC token request", u, { headers: { authorization: `bearer ${token}` } });
  if (!body?.value) throw new InputError("GitHub OIDC token request returned no token");
  return body.value;
}

async function openbaoLogin(addr, role, jwt) {
  const body = await request(`OpenBao login as role ${role}`, `${addr}/v1/auth/${AUTH_MOUNT}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, jwt }),
  });
  const token = body?.auth?.client_token;
  if (!token) throw new InputError(`OpenBao login as role ${role} returned no token`);
  console.log(`::add-mask::${token}`);
  return token;
}

async function checkMetadata(addr, token) {
  const body = await request(`read of ${CREDENTIAL_PATH} metadata`, `${addr}/v1/${KV_MOUNT}/metadata/${KV_KEY}`, {
    headers: { "x-vault-token": token },
  });
  const current = body?.data?.current_version;
  const version = body?.data?.versions?.[String(current)];
  if (!current || !version || version.destroyed || version.deletion_time) {
    throw new InputError("it has no current version");
  }
  return current;
}

/** The capabilities each ACL policy grants on one exact path (HCL or JSON policy text). */
function pathCapabilities(policyText, path) {
  const found = [];
  const text = String(policyText ?? "");
  try {
    const doc = JSON.parse(text);
    const rules = doc?.path ?? {};
    for (const rule of Array.isArray(rules) ? rules : [rules]) {
      const caps = rule?.[path]?.capabilities;
      if (Array.isArray(caps)) found.push(...caps.map(String));
    }
    return found;
  } catch {
    // Not JSON: HCL.
  }
  const block = /path\s+"([^"]*)"\s*\{([^}]*)\}/g;
  for (const [, p, body] of text.matchAll(block)) {
    if (p !== path) continue;
    const caps = /capabilities\s*=\s*\[([^\]]*)\]/.exec(body);
    if (caps) found.push(...[...caps[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]));
  }
  return found;
}

/**
 * Proves the publish role could read the credential without reading it: the
 * role exists and its policies grant `read` on the credential's data path and
 * none denies it. Reads only role configuration and policy text, no secret.
 */
async function checkPublishCanRead(addr, token) {
  const role = ROLES.login;
  const dataPath = `${KV_MOUNT}/data/${KV_KEY}`;
  const body = await request(`read of OpenBao role ${role}`, `${addr}/v1/auth/${AUTH_MOUNT}/role/${role}`, {
    headers: { "x-vault-token": token },
  });
  const policies = [...new Set([...(body?.data?.token_policies ?? []), ...(body?.data?.policies ?? [])].map(String))];
  if (!policies.length) throw new InputError(`role ${role} has no policies, so the publish cannot read it`);
  const caps = [];
  for (const name of policies) {
    const p = await request(`read of OpenBao policy ${name}`, `${addr}/v1/sys/policies/acl/${encodeURIComponent(name)}`, {
      headers: { "x-vault-token": token },
    });
    caps.push(...pathCapabilities(p?.data?.policy, dataPath));
  }
  if (caps.includes("deny") || !caps.includes("read")) {
    throw new InputError(`role ${role} cannot read it: its policies (${policies.join(", ")}) grant no read on ${dataPath}`);
  }
}

async function readCredential(addr, token) {
  const body = await request(`read of ${CREDENTIAL_PATH}`, `${addr}/v1/${KV_MOUNT}/data/${KV_KEY}`, {
    headers: { "x-vault-token": token },
  });
  const data = body?.data?.data ?? {};
  const missing = ["username", "password"].filter((k) => typeof data[k] !== "string" || data[k] === "");
  if (missing.length) throw new InputError(`it has no ${missing.join(", ")} property`);
  console.log(`::add-mask::${data.password}`);
  return { username: data.username, password: data.password };
}

function dockerLogin(registry, { username, password }) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["login", registry, "--username", username, "--password-stdin"], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new InputError(`docker login to ${registry} exited ${code}`))));
    child.stdin.end(password);
  });
}

async function main(mode) {
  if (!(mode in ROLES)) {
    console.error("usage: estate-registry-credential.mjs check|login");
    process.exitCode = 2;
    return;
  }
  const registry = process.env.ESTATE_REGISTRY ?? "";
  const addr = (process.env.OPENBAO_ADDR ?? "").replace(/\/+$/, "");
  let missing = false;
  for (const [name, value] of [["ESTATE_REGISTRY", registry], ["OPENBAO_ADDR", addr]]) {
    if (!value) {
      fail(`repository variable ${name} is not set`);
      missing = true;
    }
  }
  if (missing) return;

  let credentialStep = true;
  try {
    const jwt = await oidcToken();
    const token = await openbaoLogin(addr, ROLES[mode], jwt);
    if (mode === "check") {
      const version = await checkMetadata(addr, token);
      await checkPublishCanRead(addr, token);
      console.log(`ok: ESTATE_REGISTRY is set and OpenBao push credential ${CREDENTIAL_PATH} is reachable (version ${version}) and readable by role ${ROLES.login}`);
      return;
    }
    const credential = await readCredential(addr, token);
    credentialStep = false;
    await dockerLogin(registry, credential);
    console.log(`ok: logged in to ESTATE_REGISTRY with OpenBao push credential ${CREDENTIAL_PATH}`);
  } catch (err) {
    const why = err instanceof InputError ? err.message : String(err);
    fail(credentialStep ? `OpenBao push credential ${CREDENTIAL_PATH} is unreachable: ${why}` : why);
  }
}

await main(process.argv[2]);
