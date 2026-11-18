// The public directory listings reader: the `read` behind the
// anthropic_listings PortalReadSource (sources.ts). For each tracked listing it
// makes one anonymous GET of that listing's public directory page (the URL per
// listing comes from its When's source binding in the graph, listing-targets.ts)
// and turns the page into a PortalObservation: subject = the listing, status =
// whether it is live, fields = the public metadata the page carries.
//
// No credential is configured, sent or stored, and no portal is logged in to:
// the request carries no Authorization header and omits cookies. A listing
// whose public page does not exist (404/410) reads as NOT_LISTED, a status the
// sensor records like any other (in-review status is not public). A page that
// cannot be read (network failure, any other non-2xx) fails the whole read, so
// the sensor records no heartbeat rather than mistaking an outage for a change.
import type { PortalObservation } from "./sources.ts";

/** The status of a listing whose public directory page is there. */
export const LIVE = "live";
/** The status of a listing absent from the public directory. */
export const NOT_LISTED = "not_listed";

export interface PublicListing {
  readonly subject: string;
  readonly url: string;
}

export interface PublicListingConfig {
  readonly listings: readonly PublicListing[];
}

/**
 * A listing's public page URL, checked: absolute http(s), with no userinfo (a
 * credential has no place in it). Throws naming the listing otherwise.
 */
export function publicPageUrl(subject: string, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`the page for listing ${subject} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`the page for listing ${subject} is not an http(s) URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`the page for listing ${subject} carries credentials; only public pages are read`);
  }
  return url;
}

export type ListingReadErrorKind = "http" | "network";

/** A read that could not see a listing's public page. */
export class ListingReadError extends Error {
  readonly kind: ListingReadErrorKind;
  readonly subject: string;
  readonly status: number | undefined;

  constructor(kind: ListingReadErrorKind, subject: string, message: string, status?: number) {
    super(message);
    this.name = "ListingReadError";
    this.kind = kind;
    this.subject = subject;
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PublicListingReaderOptions extends PublicListingConfig {
  /** Replaced in tests by a stub directory. */
  fetch?: FetchLike;
  /** Abort each page read after this long (default 30s). */
  timeout_ms?: number;
}

export class PublicListingReader {
  readonly listings: readonly PublicListing[];
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: PublicListingReaderOptions) {
    const seen = new Set<string>();
    for (const l of options.listings) {
      if (seen.has(l.subject)) throw new Error(`listing ${l.subject} is configured more than once`);
      seen.add(l.subject);
    }
    this.listings = options.listings;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeout_ms ?? 30_000;
  }

  /** Reads every tracked listing's public page once. Bound, so it can be passed as PortalReadConfig.read. */
  readonly read = async (): Promise<PortalObservation[]> => {
    const observations: PortalObservation[] = [];
    for (const listing of this.listings) observations.push(await this.#readOne(listing));
    return observations;
  };

  async #readOne({ subject, url }: PublicListing): Promise<PortalObservation> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: { accept: "text/html,application/xhtml+xml" },
        credentials: "omit",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new ListingReadError("network", subject, `public directory page for ${subject} is unreachable: ${message(err)}`);
    }
    const { status } = response;
    if (status === 404 || status === 410) {
      await response.body?.cancel();
      return { subject, status: NOT_LISTED };
    }
    if (status < 200 || status >= 300) {
      await response.body?.cancel();
      throw new ListingReadError("http", subject, `public directory page for ${subject} could not be read (HTTP ${status})`, status);
    }
    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      throw new ListingReadError("network", subject, `public directory page for ${subject} could not be read: ${message(err)}`);
    }
    return { subject, status: LIVE, fields: pageFields(body) };
  }
}

/**
 * The public metadata a directory page carries in its head: name (og:title,
 * else <title>), description (og:description, else meta description) and the
 * canonical url. Absent fields are omitted.
 */
export function pageFields(html: string): Record<string, string> {
  const metas = new Map<string, string>();
  let canonical: string | undefined;
  for (const tag of html.matchAll(/<(meta|link)\b([^>]*)>/gi)) {
    const attrs = attributes(tag[2] ?? "");
    if (tag[1]!.toLowerCase() === "meta") {
      const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
      const content = attrs.get("content");
      if (key && content !== undefined && !metas.has(key)) metas.set(key, content);
    } else if (canonical === undefined && attrs.get("rel")?.toLowerCase().split(/\s+/).includes("canonical")) {
      canonical = attrs.get("href");
    }
  }
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const fields: Record<string, string> = {};
  const set = (key: string, value: string | undefined) => {
    const v = value === undefined ? undefined : decodeEntities(value).replace(/\s+/g, " ").trim();
    if (v) fields[key] = v;
  };
  set("name", metas.get("og:title") ?? title);
  set("description", metas.get("og:description") ?? metas.get("description"));
  set("url", canonical ?? metas.get("og:url"));
  return fields;
}

function attributes(text: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of text.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
