// LC-EST-OVERLAY acceptance: deploy/overlays/aks-obs-01, the overlay the
// estate's Argo CD syncs, pins the API Deployment and the schema Job to one
// estate-registry loopcloser:sha-<commit> image. The Job runs the migrate
// entrypoint with DATABASE_URL from loopcloser-db-app/uri as an Argo CD
// Sync-phase hook, in a wave after the CNPG cluster and before the API. The
// tick CronJob, unsuspended here, is checked by aks-obs-01-overlay.test.ts.
//
// Renders with a real kustomize and validates with the offline schema check
// (tests/deploy/manifest-check.ts). Nothing here talks to a cluster, a
// registry or Argo CD, and no secret is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { kustomizeBuild, parseObjects, repoRoot, SCHEMA_DIR, validate, type Obj } from "./manifest-check.ts";
import { buildEntrypoints, manifestScriptIn } from "../support/entrypoint-build.ts";
import { loadPublicListingConfig, PUBLIC_LISTING_ENV } from "../../src/sensors/public-listing.ts";

const OVERLAY = join(repoRoot, "deploy", "overlays", "aks-obs-01");
const NAMESPACE = "loop-closer";
const DB_CLUSTER = "loopcloser-db";
const DB_SECRET = `${DB_CLUSTER}-app`;
const API = "loopcloser";
const SCHEMA_JOB = "loopcloser-schema";
const PULL_SECRET = "loopcloser-registry-pull";
const LISTINGS_READ = "loopcloser-listings-read";
const LISTINGS_PAGES = "loopcloser-listings-pages";
// .github/workflows/estate-image.yml pushes `<ESTATE_REGISTRY>/loopcloser:sha-<full commit sha>`.
const ESTATE_IMAGE = /^(?<repo>[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)*\/loopcloser):sha-(?<sha>[0-9a-f]{40})$/;

function render(): Obj[] {
  return parseObjects(kustomizeBuild(OVERLAY));
}

function one(objs: Obj[], kind: string, name: string): Obj {
  const found = objs.filter((o) => o["kind"] === kind && o["metadata"]?.["name"] === name);
  assert.equal(found.length, 1, `expected exactly one ${kind}/${name}`);
  return found[0]!;
}

function podSpec(o: Obj): Obj {
  return o["kind"] === "CronJob" ? o["spec"]["jobTemplate"]["spec"]["template"]["spec"] : o["spec"]["template"]["spec"];
}

function soleContainer(o: Obj): Obj {
  const pod = podSpec(o);
  assert.equal(pod["initContainers"], undefined, `${o["kind"]}/${o["metadata"]["name"]} has no init containers`);
  assert.equal((pod["containers"] as Obj[]).length, 1, `${o["kind"]}/${o["metadata"]["name"]} has one container`);
  return pod["containers"][0] as Obj;
}

function annotations(o: Obj): Record<string, string> {
  return (o["metadata"]?.["annotations"] ?? {}) as Record<string, string>;
}

function wave(o: Obj): number {
  const w = annotations(o)["argocd.argoproj.io/sync-wave"] ?? "0";
  assert.match(w, /^-?[0-9]+$/, `${o["kind"]}/${o["metadata"]["name"]} sync-wave is an integer`);
  return Number(w);
}

// The registry host the estate pull credential covers (docs/ops/registry-pull.md,
// property `registry`): the pinned image must come from it or the pull fails.
function pullRegistryHost(): string {
  const doc = readFileSync(join(repoRoot, "docs", "ops", "registry-pull.md"), "utf8");
  const m = /^\| `registry` \| [^|]*\(`([^`]+)`\)/m.exec(doc);
  assert.ok(m, "docs/ops/registry-pull.md records the pull registry host");
  return m[1]!;
}

test("the aks-obs-01 overlay pins the API and the schema Job to the same estate-registry sha tag with DATABASE_URL from loopcloser-db-app", () => {
  const objs = render();
  const api = one(objs, "Deployment", API);
  const job = one(objs, "Job", SCHEMA_JOB);
  const apiContainer = soleContainer(api);
  const jobContainer = soleContainer(job);

  // One image, pinned to the estate registry's sha-<commit> tag: never the
  // floating GHCR `main` tag the base package carries.
  const image = apiContainer["image"] as string;
  const m = ESTATE_IMAGE.exec(image);
  assert.ok(m, `the API image ${image} is <estate registry>/loopcloser:sha-<40-hex commit>`);
  assert.notEqual(m.groups!["repo"], "ghcr.io/noncelogic/loop-closer", "not the CI (job `image`) package");
  assert.equal(m.groups!["repo"]!.split("/")[0], pullRegistryHost(), "the registry the estate pull credential covers");
  assert.equal(jobContainer["image"], image, "the schema Job runs the API's image");

  // Every loopcloser container in the overlay runs that one image.
  for (const o of objs) {
    if (!["Deployment", "Job", "CronJob"].includes(o["kind"])) continue;
    for (const c of podSpec(o)["containers"] as Obj[]) {
      assert.equal(c["image"], image, `${o["kind"]}/${o["metadata"]["name"]} container ${c["name"]} image`);
    }
    assert.deepEqual(podSpec(o)["imagePullSecrets"], [{ name: PULL_SECRET }], `${o["kind"]}/${o["metadata"]["name"]} pulls with ${PULL_SECRET}`);
  }

  // The Job runs the migrate entrypoint against the CNPG app URI, as the API does.
  assert.deepEqual(jobContainer["command"], ["node", "dist/migrate.js"]);
  assert.equal(jobContainer["args"], undefined);
  const dbUrl = { secretKeyRef: { name: DB_SECRET, key: "uri" } };
  const jobEnv = new Map((jobContainer["env"] as Obj[]).map((e) => [e["name"] as string, e]));
  assert.deepEqual([...jobEnv.keys()], ["DATABASE_URL"], "the migrate entrypoint reads DATABASE_URL only");
  assert.deepEqual(jobEnv.get("DATABASE_URL")!["valueFrom"], dbUrl);
  const apiEnv = new Map((apiContainer["env"] as Obj[]).map((e) => [e["name"] as string, e]));
  assert.deepEqual(apiEnv.get("DATABASE_URL")?.["valueFrom"], dbUrl);
  assert.deepEqual(apiContainer["command"], ["node", "dist/main.js"]);

  // Everything namespaced lands in loop-closer, and the Job runs to completion once.
  for (const o of objs) if (o["kind"] !== "Namespace") assert.equal(o["metadata"]["namespace"], NAMESPACE, `${o["kind"]}/${o["metadata"]["name"]} namespace`);
  assert.equal(podSpec(job)["restartPolicy"], "Never");
  assert.equal(podSpec(job)["automountServiceAccountToken"], false);
});

test("the schema Job is a Sync hook ordered after the loopcloser-db cluster and before the API Deployment, with a hook delete policy", () => {
  const objs = render();
  const db = one(objs, "Cluster", DB_CLUSTER);
  const job = one(objs, "Job", SCHEMA_JOB);
  const api = one(objs, "Deployment", API);

  const a = annotations(job);
  assert.equal(a["argocd.argoproj.io/hook"], "Sync", "a Sync-phase hook");
  const policies = (a["argocd.argoproj.io/hook-delete-policy"] ?? "").split(",").map((p) => p.trim());
  assert.ok(policies.length > 0 && policies[0] !== "", "the Job has a hook delete policy");
  for (const p of policies) assert.ok(["HookSucceeded", "HookFailed", "BeforeHookCreation"].includes(p), `known hook delete policy ${p}`);
  // A re-sync replaces the previous run's Job (its image is immutable) rather than failing on it.
  assert.ok(policies.includes("BeforeHookCreation"), "BeforeHookCreation, so each sync runs a fresh Job");

  // The cluster and the API are plain synced resources, not hooks.
  assert.equal(annotations(db)["argocd.argoproj.io/hook"], undefined);
  assert.equal(annotations(api)["argocd.argoproj.io/hook"], undefined);
  assert.ok(wave(db) < wave(job), `the Job (wave ${wave(job)}) runs after the ${DB_CLUSTER} cluster (wave ${wave(db)})`);
  assert.ok(wave(job) < wave(api), `the API (wave ${wave(api)}) rolls out after the Job (wave ${wave(job)})`);

  // What the Job needs is synced in an earlier wave: its namespace and its pull secret.
  for (const o of objs.filter((o) => o["kind"] === "Namespace" || o["kind"] === "ExternalSecret")) {
    assert.ok(wave(o) < wave(job), `${o["kind"]}/${o["metadata"]["name"]} (wave ${wave(o)}) syncs before the Job`);
  }
});

// The vendored Job schema is derived from the vendored CronJob schema's
// jobTemplate (tests/deploy/schemas/README.md); it must stay exactly that.
function derivedJobSchema(): Obj {
  const k8s = join(SCHEMA_DIR, "kubernetes", "v1.34.1-standalone-strict");
  const cron = JSON.parse(readFileSync(join(k8s, "cronjob-batch-v1.json"), "utf8")) as Obj;
  const p = cron["properties"] as Obj;
  const jt = p["spec"]["properties"]["jobTemplate"]["properties"] as Obj;
  return {
    description: "Job represents the configuration of a single job.",
    properties: {
      apiVersion: p["apiVersion"],
      kind: { ...p["kind"], enum: ["Job"] },
      metadata: jt["metadata"],
      spec: jt["spec"],
    },
    type: "object",
    "x-kubernetes-group-version-kind": [{ group: "batch", kind: "Job", version: "v1" }],
    additionalProperties: false,
    $schema: cron["$schema"],
  };
}

test("the rendered aks-obs-01 overlay passes the offline schema check including the Job and the tick CronJob", () => {
  const k8s = join(SCHEMA_DIR, "kubernetes", "v1.34.1-standalone-strict");
  assert.deepEqual(JSON.parse(readFileSync(join(k8s, "job-batch-v1.json"), "utf8")), derivedJobSchema(), "job-batch-v1.json is the derived schema");

  const rendered = kustomizeBuild(OVERLAY);
  const objs = parseObjects(rendered);
  const validated = validate(rendered).map((o) => `${o["apiVersion"]} ${o["kind"]} ${o["metadata"]?.["name"]}`);
  assert.ok(validated.includes(`batch/v1 Job ${SCHEMA_JOB}`), "the schema Job is schema-validated");
  assert.ok(validated.includes(`apps/v1 Deployment ${API}`), "the API Deployment is schema-validated");
  assert.equal(validated.length, objs.length, "every rendered object is schema-validated");

  // The schema check rejects a mistyped Job field, so the Job's pass is real.
  const job = one(objs, "Job", SCHEMA_JOB);
  assert.equal(typeof job["spec"]["backoffLimit"], "number", "the rendered Job sets backoffLimit");
  const badJob = stringify({ ...job, spec: { ...job["spec"], backoffLimit: "three" } });
  assert.throws(() => validate(badJob), /backoffLimit/);

  assert.ok(validated.includes("batch/v1 CronJob loopcloser-tick"), "the tick CronJob is schema-validated");
});

// LC-EST-PORTAL-CRON acceptance: the overlay carries the listings-read CronJob,
// suspended, running the portal-read entrypoint (src/portal-read.ts) with the
// listing page URLs from a ConfigMap. The public listing read needs no
// credential (CLOSER-122), so the only Secret it references is the graph's
// DATABASE_URL, and it mounts nothing. No listing URL is recorded yet
// (SPEC.md names the listings only, with no URL under LC-EST-PORTAL-URLS), so
// the ConfigMap tracks none (LC-EST-PORTAL-LISTINGS-NOFIX and
// LC-EST-PORTAL-LISTINGS-URLS, test/deploy/aks-obs-01-listings-read.test.ts).
test("the listings-read CronJob runs the portal-read entrypoint with listing URLs from its ConfigMap and mounts no credential", () => {
  const objs = render();
  const cron = one(objs, "CronJob", LISTINGS_READ);
  const api = one(objs, "Deployment", API);
  const job = one(objs, "Job", SCHEMA_JOB);
  const c = soleContainer(cron);
  const pod = podSpec(cron);

  // Shipped suspended: nothing is read until the listings are activated.
  assert.equal(cron["spec"]["suspend"], true, "the listings-read CronJob is suspended");
  assert.equal(cron["spec"]["concurrencyPolicy"], "Forbid");
  assert.equal(cron["metadata"]["namespace"], NAMESPACE);
  assert.deepEqual(c["command"], ["node", "dist/portal-read.js"]);
  assert.equal(c["args"], undefined);
  assert.equal(c["image"], soleContainer(api)["image"], "the API's pinned image");

  // DATABASE_URL from the CNPG app URI and the pages from the ConfigMap; nothing else.
  const env = new Map((c["env"] as Obj[]).map((e) => [e["name"] as string, e]));
  assert.deepEqual([...env.keys()].sort(), ["DATABASE_URL", PUBLIC_LISTING_ENV.pages].sort());
  assert.deepEqual(env.get("DATABASE_URL")!["valueFrom"], { secretKeyRef: { name: DB_SECRET, key: "uri" } });
  const ref = env.get(PUBLIC_LISTING_ENV.pages)!["valueFrom"]?.["configMapKeyRef"] as Obj | undefined;
  assert.ok(ref, `${PUBLIC_LISTING_ENV.pages} comes from a ConfigMap`);
  assert.equal(ref["name"], LISTINGS_PAGES);
  assert.notEqual(ref["optional"], true, "a missing ConfigMap fails the Pod, not the read");

  // No credential: no volumes or mounts, no envFrom, no ServiceAccount token,
  // and the database URI is the only Secret referenced.
  assert.equal(pod["volumes"], undefined, "no volumes");
  assert.equal(c["volumeMounts"], undefined, "no volume mounts");
  assert.equal(c["envFrom"], undefined, "no envFrom");
  assert.equal(pod["automountServiceAccountToken"], false);
  const secretRefs = (c["env"] as Obj[]).flatMap((e) => (e["valueFrom"]?.["secretKeyRef"] ? [e["valueFrom"]["secretKeyRef"]] : []));
  assert.deepEqual(secretRefs, [{ name: DB_SECRET, key: "uri" }], "only the database URI Secret");

  // The ConfigMap holds the tracked listings SPEC.md records under
  // LC-EST-PORTAL-URLS (with source page and read date) and their projection
  // the reader parses; none is recorded yet, so no listing is tracked.
  const cm = one(objs, "ConfigMap", LISTINGS_PAGES);
  assert.equal(cm["metadata"]["namespace"], NAMESPACE);
  assert.deepEqual(Object.keys(cm["data"] ?? {}).sort(), [ref["key"] as string, "tracked-listings.json"].sort());
  const raw = cm["data"]?.[ref["key"] as string] as string | undefined;
  assert.ok(raw, `ConfigMap/${LISTINGS_PAGES} carries key ${ref["key"]}`);
  assert.deepEqual(JSON.parse(cm["data"]["tracked-listings.json"] as string), [], "no tracked listing recorded");
  assert.equal(loadPublicListingConfig({ [PUBLIC_LISTING_ENV.pages]: raw }), undefined, "no listing tracked yet");

  // Syncs after the schema Job, like the other database readers.
  assert.ok(wave(cron) > wave(job), `the listings read (wave ${wave(cron)}) syncs after the schema Job (wave ${wave(job)})`);
  const validated = validate(kustomizeBuild(OVERLAY)).map((o) => `${o["kind"]} ${o["metadata"]?.["name"]}`);
  assert.ok(validated.includes(`CronJob ${LISTINGS_READ}`), "the listings-read CronJob is schema-validated");
  assert.ok(validated.includes(`ConfigMap ${LISTINGS_PAGES}`), "the listing pages ConfigMap is schema-validated");
});

// LC-EST-PORTAL-NOFIXTURE acceptance: PR #57 shipped the listings-read
// ConfigMap with two fixture listing URLs; the rendered overlay carries
// neither of them, nor any other URL on a reserved fixture domain.
const PR57_FIXTURE_URLS = [
  "https://listings.example.invalid/rove-connector",
  "https://listings.example.invalid/rove-plugin",
];

test("the aks-obs-01 overlay renders the listings-read CronJob without the PR 57 fixture URLs", () => {
  const rendered = kustomizeBuild(OVERLAY);
  const objs = parseObjects(rendered);
  const cron = one(objs, "CronJob", LISTINGS_READ);
  assert.equal(cron["spec"]["suspend"], true, "the listings-read CronJob stays suspended");
  const ref = (soleContainer(cron)["env"] as Obj[]).find((e) => e["name"] === PUBLIC_LISTING_ENV.pages)?.["valueFrom"]?.["configMapKeyRef"] as Obj | undefined;
  assert.equal(ref?.["name"], LISTINGS_PAGES, "the CronJob still references the listings ConfigMap");
  one(objs, "ConfigMap", LISTINGS_PAGES);

  for (const url of PR57_FIXTURE_URLS) assert.ok(!rendered.includes(url), `the overlay renders PR 57 fixture URL ${url}`);
  for (const url of rendered.match(/https?:\/\/[^\s"'<>)\]\\]+/g) ?? []) {
    const host = new URL(url).hostname;
    assert.doesNotMatch(host, /(^|\.)(example(\.(com|org|net))?|invalid|test|localhost)$/, `fixture URL ${url}`);
  }
});

test("the listings-read CronJob command is the build output of src/portal-read.ts in the image build, not a checked-in dist file", async () => {
  const c = soleContainer(one(render(), "CronJob", LISTINGS_READ));
  const script = (c["command"] as string[])[1]!;
  assert.equal(script, "dist/portal-read.js");

  // Nothing under dist/ is tracked: the file can only come from the build.
  const tracked = execFileSync("git", ["ls-files", "--", "dist", script], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(tracked.trim(), "", "no checked-in dist file");
  assert.ok(existsSync(join(repoRoot, "src", "portal-read.ts")), "the source entrypoint");

  // The image's build stage compiles src/ with `npm run build` and ships that dist/.
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY src \.\/src$/m);
  assert.match(dockerfile, /^RUN npm run build$/m);
  assert.match(dockerfile, /^COPY --from=build \/app\/dist \.\/dist$/m);
  assert.doesNotMatch(dockerfile, /^COPY (?!--from=build)\S*dist/m, "no dist/ copied from the build context");

  // That build emits exactly the file the command names.
  const build = await buildEntrypoints("listings-cron");
  try {
    assert.ok(existsSync(manifestScriptIn(build, script)), `the build emits ${script}`);
  } finally {
    build.remove();
  }
});

test("the overlay keeps its database and registry pull references beside the listings-read CronJob", () => {
  const objs = render();
  assert.ok(objs.some((o) => o["kind"] === "CronJob" && o["metadata"]["name"] === LISTINGS_READ));
  one(objs, "Cluster", DB_CLUSTER);
  const pull = one(objs, "ExternalSecret", PULL_SECRET);
  assert.equal(pull["spec"]["target"]["name"], PULL_SECRET);
  const dbUrl = { secretKeyRef: { name: DB_SECRET, key: "uri" } };
  for (const [kind, name] of [["Deployment", API], ["Job", SCHEMA_JOB], ["CronJob", "loopcloser-tick"], ["CronJob", LISTINGS_READ]] as const) {
    const o = one(objs, kind, name);
    assert.deepEqual(podSpec(o)["imagePullSecrets"], [{ name: PULL_SECRET }], `${kind}/${name} pulls with ${PULL_SECRET}`);
    const env = (soleContainer(o)["env"] as Obj[]).find((e) => e["name"] === "DATABASE_URL");
    assert.deepEqual(env?.["valueFrom"], dbUrl, `${kind}/${name} DATABASE_URL from ${DB_SECRET}/uri`);
  }
  // The tick stays enabled; only the listings read ships suspended.
  assert.equal(one(objs, "CronJob", "loopcloser-tick")["spec"]["suspend"], false);
});
