#!/usr/bin/env node
// Bounded wait on the estate registry for the main-only publish
// (LC-EST-PUBLISH-BOUNDED-WAIT; policy main-stays-green: a main-only step
// tolerates the external delays it depends on with a bounded wait).
//
//   node estate-registry-retry.mjs pull <ref>   # node base from the estate ACR cache; ci's `test` job
//                                               # also pulls tests/deploy/candidate-node-base.ref with it
//   node estate-registry-retry.mjs push <ref>   # the built image; writes digest=<sha256:...> to $GITHUB_OUTPUT
//
// Runs `docker pull|push <ref>` (already logged in by
// estate-registry-credential.mjs login). A transient registry failure (HTTP
// 429/5xx, timeouts, dropped connections) is retried up to REGISTRY_ATTEMPTS
// attempts with exponential backoff; at the cap the step fails with the last
// registry error. A credential or reference error, or any failure not known to
// be transient, fails on the first attempt so a misconfigured publish is never
// hidden. The wait is injectable (registryOp's `sleep`), so tests never sleep.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REGISTRY_ATTEMPTS = 5;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;

/** Wait before retry number `attempt` (1-based): 5s, 10s, 20s, 40s, capped at 60s. */
export function backoffMs(attempt) {
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}

// Checked first: these are configuration errors, never delays.
const PERMANENT = [
  /unauthorized/i,
  /authentication required/i,
  /\bdenied\b/i,
  /forbidden/i,
  /\b40[134]\b/,
  /not found/i,
  /manifest unknown/i,
  /name unknown/i,
  /invalid reference/i,
  /repository name must/i,
];
const TRANSIENT = [
  /toomanyrequests/i,
  /too many requests/i,
  /\b(429|500|502|503|504)\b/,
  /service unavailable/i,
  /bad gateway/i,
  /gateway time-?out/i,
  /internal server error/i,
  /timeout/i,
  /timed out/i,
  /deadline exceeded/i,
  /connection reset/i,
  /connection refused/i,
  /broken pipe/i,
  /unexpected EOF/i,
  /server misbehaving/i,
  /temporary failure/i,
];

/** Whether a failed registry operation's output is a delay worth waiting out. */
export function isTransient(output) {
  if (PERMANENT.some((re) => re.test(output))) return false;
  return TRANSIENT.some((re) => re.test(output));
}

/** Runs `docker <args>`, echoing and capturing its output. */
function runDocker(args, env) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const take = (stream) => (chunk) => {
      output += chunk;
      stream.write(chunk);
    };
    child.stdout.on("data", take(process.stdout));
    child.stderr.on("data", take(process.stderr));
    child.on("error", (err) => resolve({ code: -1, output: `${output}${err.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

/** The last non-empty output line: the registry's own error message. */
function lastError(output, code) {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? `exit ${code}`;
}

/**
 * `docker pull|push <ref>` with a bounded wait on transient registry failures.
 * Resolves `{ attempts, output, digest? }` (push: the sha256 digest the
 * registry returned); rejects with the last registry error.
 */
export async function registryOp(op, ref, opts = {}) {
  if (op !== "pull" && op !== "push") throw new Error(`unknown registry operation ${op}`);
  const env = opts.env ?? process.env;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((line) => console.log(line));
  const what = `docker ${op} ${ref}`;
  for (let attempt = 1; ; attempt++) {
    const { code, output } = await runDocker([op, ref], env);
    if (code === 0) {
      if (op === "pull") return { attempts: attempt, output };
      const digest = /digest: (sha256:[0-9a-f]{64})/.exec(output)?.[1];
      if (!digest) throw new Error(`${what} reported no sha256 digest`);
      return { attempts: attempt, output, digest };
    }
    const error = lastError(output, code);
    if (!isTransient(output)) throw new Error(`${what} failed on attempt ${attempt} (not a transient registry error): ${error}`);
    if (attempt >= REGISTRY_ATTEMPTS) throw new Error(`${what} failed after ${REGISTRY_ATTEMPTS} attempts: ${error}`);
    const wait = backoffMs(attempt);
    log(`::warning::${what} attempt ${attempt}/${REGISTRY_ATTEMPTS} hit a transient registry error (${error}); retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
}

async function main([op, ref]) {
  if ((op !== "pull" && op !== "push") || !ref) {
    console.error("usage: estate-registry-retry.mjs pull|push <ref>");
    process.exitCode = 2;
    return;
  }
  try {
    const result = await registryOp(op, ref);
    if (result.digest) {
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `digest=${result.digest}\n`);
      console.log(`ok: pushed ${ref} (${result.digest}) on attempt ${result.attempts}`);
    } else {
      console.log(`ok: pulled ${ref} on attempt ${result.attempts}`);
    }
  } catch (err) {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
