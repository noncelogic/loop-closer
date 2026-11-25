#!/usr/bin/env node
// The batch decision of loop-closer's `batch` delivery guarantee (COND-344,
// owner INTENTS I67; delivery.yaml). The deploy workflow (deploy.yml) fires once per
// deploy_queue.interval_seconds; this script decides whether that batch holds
// any change: it reads the last successful deploy run on main (one
// request, one row, no paging) and writes `run=true` to GITHUB_OUTPUT when main
// moved since that run's commit (or there is none yet), `run=false` when the
// batch is empty. The deploy job (candidate deploy, E2E, journeys) runs only on `run=true`, so E2E runs once per
// batch and never twice on the same commit. An unreadable history fails the
// job naming the cause; it is never read as "nothing changed".
//
// The pull request's dry run (deploy-dry-run.yml, DRY_RUN_OF=batch) runs this
// same decision and output, but its history read is answered by
// firstBatchHistory, never by GitHub: the queue it dry-runs may not be on main
// yet (GitHub answers 404 for a workflow it has never run), and a pull
// request's candidate is always a first batch. Only the read is replaced.
//
//   GITHUB_REPOSITORY=owner/name GITHUB_SHA=<main head> GITHUB_TOKEN=<actions: read> \
//     node delivery-batch.mjs
// Checked by tests/delivery/batch.test.ts.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const BATCH_WORKFLOW = "deploy.yml";
const API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 20_000;

function runsUrl(repo) {
  return `${API}/repos/${repo}/actions/workflows/${BATCH_WORKFLOW}/runs?branch=main&status=success&per_page=1`;
}

/**
 * The batch history a dry run reads: no successful batch yet, so its batch is a first batch. A transport that
 * answers only the last-successful-batch read for `repo` and fails any other request.
 */
export function firstBatchHistory(repo) {
  const url = runsUrl(repo);
  return async (u) => {
    if (String(u) !== url) throw new Error(`the dry run's batch history answers only ${url}, not ${String(u)}`);
    return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Whether the batch ending at `headSha` holds a change since the last successful batch. */
export async function batchDecision({ repo, headSha, token, fetch = globalThis.fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo ?? ""))) throw new Error(`repository ${JSON.stringify(repo)} is not owner/name`);
  if (!headSha) throw new Error("no head sha for the batch");
  if (!token) throw new Error("no GitHub token to read the last batch");
  const res = await fetch(runsUrl(repo), {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`reading the last successful batch failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  if (!Array.isArray(body?.workflow_runs)) throw new Error("the runs response has no workflow_runs list");
  const last = body.workflow_runs[0];
  if (last === undefined) return { run: true, since: null };
  if (typeof last.head_sha !== "string" || !last.head_sha) throw new Error("the last successful batch has no head_sha");
  return { run: last.head_sha !== headSha, since: last.head_sha };
}

/**
 * The batch step: decides the batch for the workflow environment `env` and writes `run` and `since` to its
 * GITHUB_OUTPUT. A dry run of the batch job (DRY_RUN_OF=batch) reads its history from firstBatchHistory;
 * every other run reads it through `fetch` (GitHub).
 */
export async function runBatch({ env = process.env, fetch = globalThis.fetch, log = console.log } = {}) {
  const dryRun = env.DRY_RUN_OF !== undefined;
  if (dryRun && env.DRY_RUN_OF !== "batch") throw new Error(`DRY_RUN_OF is ${JSON.stringify(env.DRY_RUN_OF)}, not batch`);
  const d = await batchDecision({
    repo: env.GITHUB_REPOSITORY,
    headSha: env.GITHUB_SHA,
    token: env.GITHUB_TOKEN,
    fetch: dryRun ? firstBatchHistory(env.GITHUB_REPOSITORY) : fetch,
  });
  const head = env.GITHUB_SHA;
  if (dryRun) log("dry run of the batch job: the batch history is a first batch (no live read)");
  log(d.run
    ? `batch ${d.since ?? "(first)"}..${head} holds changes: the candidate is deployed and verified`
    : `batch is empty: main is still ${head}, verified by the last successful batch; deploy skipped`);
  const out = env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `run=${d.run}\nsince=${d.since ?? ""}\n`);
  return d;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runBatch().catch((err) => {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  });
}
