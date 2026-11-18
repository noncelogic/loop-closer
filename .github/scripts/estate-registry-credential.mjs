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

/**
 * Tokenises ACL policy HCL. Comments (`#`, `//`, `/* *\/`) are dropped, so a
 * commented-out grant is never read as an active one; strings keep their
 * escapes. Anything outside the subset ACL policies use (heredocs, stray
 * characters, an unterminated string or comment) throws, so the dry run fails
 * closed instead of guessing.
 */
function hclTokens(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated /* comment");
      i = end + 2;
    } else if (c === '"') {
      let value = "";
      i++;
      for (;;) {
        if (i >= text.length || text[i] === "\n") throw new Error("unterminated string");
        const ch = text[i++];
        if (ch === '"') break;
        if (ch === "\\") {
          const esc = text[i++];
          value += esc === "n" ? "\n" : esc === "t" ? "\t" : esc;
        } else {
          value += ch;
        }
      }
      tokens.push({ kind: "string", value });
    } else if ("{}[]=,:".includes(c)) {
      tokens.push({ kind: c });
      i++;
    } else if (/[A-Za-z0-9_.\-]/.test(c)) {
      const m = /^[A-Za-z0-9_.\-]+/.exec(text.slice(i));
      tokens.push({ kind: "word", value: m[0] });
      i += m[0].length;
    } else {
      throw new Error(`unexpected ${JSON.stringify(c)}`);
    }
  }
  return tokens;
}

/** Parses ACL policy HCL into `{ path: [{ path, capabilities }] }`; throws on anything else. */
function parseHclPolicy(text) {
  const t = hclTokens(text);
  let i = 0;
  const peek = () => t[i]?.kind;
  const expect = (kind) => {
    if (t[i]?.kind !== kind) throw new Error(`expected ${kind}, found ${t[i]?.kind ?? "end of policy"}`);
    return t[i++];
  };
  function value() {
    const k = peek();
    if (k === "string" || k === "word") return t[i++].value;
    if (k === "[") {
      i++;
      const list = [];
      while (peek() !== "]") {
        list.push(value());
        if (peek() === ",") i++;
        else if (peek() !== "]") throw new Error("expected , or ] in list");
      }
      i++;
      return list;
    }
    if (k === "{") {
      i++;
      const obj = body("}");
      i++;
      return obj;
    }
    throw new Error(`unexpected ${k ?? "end of policy"}`);
  }
  // A body: `key = value` attributes and `name "label" { ... }` blocks.
  function body(close) {
    const attrs = {};
    const blocks = [];
    while (peek() !== close) {
      if (peek() !== "word" && peek() !== "string") throw new Error(`unexpected ${peek() ?? "end of policy"}`);
      const key = t[i++].value;
      if (peek() === "=" || peek() === ":") {
        i++;
        attrs[key] = value();
        if (peek() === ",") i++;
        continue;
      }
      const labels = [];
      while (peek() === "string") labels.push(t[i++].value);
      expect("{");
      const inner = body("}");
      i++;
      blocks.push({ type: key, labels, ...inner });
    }
    return { attrs, blocks };
  }
  const doc = body(undefined);
  const rules = [];
  for (const b of doc.blocks) {
    if (b.type !== "path") continue;
    if (b.labels.length !== 1) throw new Error("a path block takes exactly one path");
    const caps = b.attrs.capabilities ?? [];
    if (!Array.isArray(caps) || caps.some((c) => typeof c !== "string")) throw new Error(`capabilities of path "${b.labels[0]}" is not a list of strings`);
    rules.push({ path: b.labels[0], capabilities: caps });
  }
  return rules;
}

/**
 * The capabilities one ACL policy grants on one exact path (HCL or JSON policy
 * text). Policy text that cannot be parsed throws, so it never counts as a
 * grant.
 */
function pathCapabilities(name, policyText, path) {
  const found = [];
  const text = String(policyText ?? "");
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = undefined; // Not JSON: HCL.
  }
  if (doc !== undefined) {
    const rules = doc?.path ?? {};
    for (const rule of Array.isArray(rules) ? rules : [rules]) {
      const caps = rule?.[path]?.capabilities;
      if (Array.isArray(caps)) found.push(...caps.map(String));
    }
    return found;
  }
  let rules;
  try {
    rules = parseHclPolicy(text);
  } catch (err) {
    throw new InputError(`OpenBao policy ${name} could not be parsed (${err.message}), so its grants are unknown`);
  }
  for (const rule of rules) if (rule.path === path) found.push(...rule.capabilities);
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
    caps.push(...pathCapabilities(name, p?.data?.policy, dataPath));
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
