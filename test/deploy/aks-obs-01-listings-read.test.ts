// LC-EST-PORTAL-LISTINGS-NOFIX acceptance: the suspended listings-read
// CronJob in deploy/overlays/aks-obs-01 reads its listing URLs only from the
// overlay's tracked-listings ConfigMap (loopcloser-listings-pages), and that
// ConfigMap carries no fixture URL: it holds exactly the live public page URLs
// SPEC.md records beside the listings (CLOSER-205's current default). SPEC.md
// records none, so the list is empty and the CronJob stays suspended.
//
// LC-EST-PORTAL-LISTINGS-URLS acceptance: the tracked list is exactly the Rove
// directory-listing URLs SPEC.md records under CLOSER-205's answer
// (LC-EST-PORTAL-URLS), each carried with its recorded source page and read
// date (ConfigMap key tracked-listings.json, whose projection is the reader's
// directory-pages.json). SPEC.md records no such URL today, so both are empty.
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
const TRACKED_KEY = "tracked-listings.json";
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

interface TrackedListing {
  listing: string;
  url: string;
  source: string;
  read: string;
}

/**
 * The listing URLs SPEC.md records under CLOSER-205's answer: every line that
 * names LC-EST-PORTAL-URLS, plus the list items directly under it, in the form
 * `- <listing>: <url> (source: <url>, read YYYY-MM-DD)`. A URL there in any
 * other form fails, so a recorded URL is never silently dropped.
 */
function specTrackedListings(): TrackedListing[] {
  const lines = readFileSync(join(repoRoot, "SPEC.md"), "utf8").split("\n");
  const out: TrackedListing[] = [];
  const RECORD = /^\s*[-*]\s+(?<listing>[^:]+?):\s+(?<url>https?:\/\/\S+)\s+\(source:\s+(?<source>https?:\/\/[^\s,)]+),\s+read\s+(?<read>\d{4}-\d{2}-\d{2})\)\s*$/;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes("LC-EST-PORTAL-URLS")) continue;
    assert.deepEqual(lines[i]!.match(URL_RE) ?? [], [], "the LC-EST-PORTAL-URLS heading line carries no URL itself");
    for (let j = i + 1; j < lines.length && /^\s*[-*]\s/.test(lines[j]!); j++) {
      if ((lines[j]!.match(URL_RE) ?? []).length === 0) continue;
      const m = RECORD.exec(lines[j]!);
      assert.ok(m, `SPEC.md line ${j + 1} records a listing URL with its source page and read date`);
      const g = m.groups!;
      out.push({ listing: g["listing"]!.trim(), url: g["url"]!, source: g["source"]!, read: g["read"]! });
    }
  }
  return out;
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

test("the aks-obs-01 listings-read CronJob carries no fixture URL and lists each tracked directory listing URL", () => {
  const objs = parseObjects(kustomizeBuild(OVERLAY));
  const cron = one(objs, "CronJob", LISTINGS_READ);
  const cm = one(objs, "ConfigMap", TRACKED_LISTINGS);
  assert.equal(cron["spec"]["suspend"], true, "the listings-read CronJob stays suspended (activation is CLOSER-215)");
  for (const o of objs) {
    for (const url of JSON.stringify(o).match(URL_RE) ?? []) {
      assert.ok(!isFixture(url), `${o["kind"]}/${o["metadata"]["name"]} carries fixture URL ${url}`);
    }
  }

  // Each tracked listing carries its URL, its recorded source page and its read date.
  const rawTracked = cm["data"]?.[TRACKED_KEY] as string | undefined;
  assert.ok(rawTracked !== undefined, `ConfigMap/${TRACKED_LISTINGS} carries key ${TRACKED_KEY}`);
  const tracked = JSON.parse(rawTracked) as TrackedListing[];
  assert.ok(Array.isArray(tracked), `${TRACKED_KEY} is a JSON array`);
  for (const t of tracked) {
    assert.deepEqual(Object.keys(t).sort(), ["listing", "read", "source", "url"], "listing, url, source, read");
    for (const u of [t.url, t.source]) assert.match(new URL(u).protocol, /^https?:$/);
    assert.match(t.read, /^\d{4}-\d{2}-\d{2}$/, `${t.listing}: read date`);
    assert.equal(new Date(`${t.read}T00:00:00Z`).toISOString().slice(0, 10), t.read, `${t.listing}: a real date`);
  }

  // Exactly what SPEC.md records under CLOSER-205's answer: none today.
  const recorded = specTrackedListings();
  const key = (t: TrackedListing) => JSON.stringify([t.listing, t.url, t.source, t.read]);
  assert.deepEqual(tracked.map(key).sort(), recorded.map(key).sort(), "exactly the listings SPEC.md records under LC-EST-PORTAL-URLS");
  assert.deepEqual(recorded, [], "SPEC.md records no Rove listing URL yet");

  // The reader's pages are the projection of the tracked list, nothing more.
  const pages = JSON.parse(cm["data"][PAGES_KEY] as string) as Record<string, string>;
  assert.deepEqual(pages, Object.fromEntries(tracked.map((t) => [t.listing, t.url])), `${PAGES_KEY} is ${TRACKED_KEY} projected`);
  assert.equal(loadPublicListingConfig({ [PUBLIC_LISTING_ENV.pages]: cm["data"][PAGES_KEY] }), undefined, "no listing tracked");
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
