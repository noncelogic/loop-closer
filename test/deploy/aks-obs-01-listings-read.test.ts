// LC-EST-PORTAL-LISTINGS-NOFIX acceptance: the suspended listings-read
// CronJob in deploy/overlays/aks-obs-01 reads its listing URLs only from the
// overlay's tracked-listings ConfigMap (loopcloser-listings-pages), and that
// ConfigMap carries no fixture URL: it holds exactly the live public page URLs
// SPEC.md records beside the listings (CLOSER-205's current default). SPEC.md
// records none, so the list is empty and the CronJob stays suspended.
//
// Rendered-manifest checks only (a real kustomize, tests/deploy/manifest-check.ts);
// nothing here reads a listing page, a cluster or a secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kustomizeBuild, parseObjects, repoRoot, type Obj } from "../../tests/deploy/manifest-check.ts";
import { loadPublicListingConfig, PUBLIC_LISTING_ENV } from "../../src/sensors/public-listing.ts";

const OVERLAY = join(repoRoot, "deploy", "overlays", "aks-obs-01");
const LISTINGS_READ = "loopcloser-listings-read";
const TRACKED_LISTINGS = "loopcloser-listings-pages";
const PAGES_KEY = "directory-pages.json";
const URL_RE = /https?:\/\/[^\s"'<>)\]\\]+/g;

function one(objs: Obj[], kind: string, name: string): Obj {
  const found = objs.filter((o) => o["kind"] === kind && o["metadata"]?.["name"] === name);
  assert.equal(found.length, 1, `expected exactly one ${kind}/${name}`);
  return found[0]!;
}

function container(cron: Obj): Obj {
  const containers = cron["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"] as Obj[];
  assert.equal(containers.length, 1);
  return containers[0]!;
}

/** The live public page URLs SPEC.md records beside the directory listings (the directory-listing loops entry). */
function specListingUrls(): string[] {
  const spec = readFileSync(join(repoRoot, "SPEC.md"), "utf8");
  const entry = spec.split("\n").find((l) => l.startsWith("**Directory-listing loops"));
  assert.ok(entry, "SPEC.md has the directory-listing loops entry");
  assert.match(entry, /Rove connector listing/);
  assert.match(entry, /Rove plugin listing/);
  return entry.match(URL_RE) ?? [];
}

/** True for a URL on a reserved test/documentation domain (RFC 2606/6761). */
function isFixture(url: string): boolean {
  const host = new URL(url).hostname;
  return /(^|\.)(example(\.(com|org|net))?|invalid|test|localhost)$/.test(host);
}

test("the aks-obs-01 listings-read CronJob carries no fixture URL and stays suspended", () => {
  const objs = parseObjects(kustomizeBuild(OVERLAY));
  const cron = one(objs, "CronJob", LISTINGS_READ);
  const cm = one(objs, "ConfigMap", TRACKED_LISTINGS);
  assert.equal(cron["spec"]["suspend"], true, "the listings-read CronJob stays suspended");

  // Neither object, nor anything else the overlay renders, names a fixture URL.
  for (const o of objs) {
    for (const url of JSON.stringify(o).match(URL_RE) ?? []) {
      assert.ok(!isFixture(url), `${o["kind"]}/${o["metadata"]["name"]} carries fixture URL ${url}`);
    }
  }

  // The tracked list is exactly what SPEC.md records: none at filing, so empty.
  const raw = cm["data"]?.[PAGES_KEY] as string | undefined;
  assert.ok(raw !== undefined, `ConfigMap/${TRACKED_LISTINGS} carries key ${PAGES_KEY}`);
  const pages = JSON.parse(raw) as Record<string, string>;
  assert.equal(typeof pages, "object");
  for (const url of Object.values(pages)) assert.ok(!isFixture(url), `${url} is not a fixture URL`);
  assert.deepEqual(Object.values(pages).sort(), specListingUrls().sort(), "exactly the listing URLs SPEC.md records");
  assert.deepEqual(pages, {}, "SPEC.md records no listing URL, so nothing is tracked");
  assert.equal(loadPublicListingConfig({ [PUBLIC_LISTING_ENV.pages]: raw }), undefined, "the reader sees no tracked listing");
});

test("the aks-obs-01 listings-read CronJob reads its listing URLs only from the tracked-listings ConfigMap", () => {
  const objs = parseObjects(kustomizeBuild(OVERLAY));
  const cron = one(objs, "CronJob", LISTINGS_READ);
  const c = container(cron);

  assert.equal(c["args"], undefined, "no URL passed as an argument");
  assert.equal(c["envFrom"], undefined, "no envFrom");
  const env = c["env"] as Obj[];
  const pages = env.filter((e) => e["name"] === PUBLIC_LISTING_ENV.pages);
  assert.equal(pages.length, 1, `one ${PUBLIC_LISTING_ENV.pages}`);
  assert.equal(pages[0]!["value"], undefined, "no inline listing URLs");
  assert.deepEqual(pages[0]!["valueFrom"], { configMapKeyRef: { name: TRACKED_LISTINGS, key: PAGES_KEY } });

  // No other place in the CronJob carries a URL: the only URLs are the ConfigMap's.
  assert.deepEqual(JSON.stringify(cron).match(URL_RE) ?? [], [], "the CronJob itself names no URL");
  one(objs, "ConfigMap", TRACKED_LISTINGS);
});
