// The authenticated Anthropic listings portal reader: the `read` behind the
// anthropic_listings PortalReadSource (sources.ts). One authenticated GET of
// the portal's listings, parsed into the PortalObservations the sensor
// compares (subject = listing slug, status = review status).
//
// The credential comes from runtime configuration (a mounted secret file, as
// the API keys are; src/config.ts) and is only ever placed in the request's
// Authorization header. Every error the reader raises is built from fixed text
// plus the HTTP status and is scrubbed of the credential, so a failed read can
// be recorded as a sensor error or logged without leaking it, even when the
// portal echoes the credential back in its response.
import { existsSync, readFileSync } from "node:fs";
import type { PortalObservation } from "./sources.ts";

/** The environment variables that configure the reader. */
export const ANTHROPIC_PORTAL_ENV = {
  /** The portal's listings URL. */
  url: "ANTHROPIC_PORTAL_URL",
  /** Path of the mounted secret file holding the portal credential. */
  credentialFile: "ANTHROPIC_PORTAL_CREDENTIAL_FILE",
} as const;

export interface AnthropicPortalConfig {
  readonly url: string;
  readonly credential: string;
}

/**
 * The reader's configuration from the environment; undefined when the portal
 * is not configured at all (the sensor is then not run). Errors name the
 * variable or file, never the credential.
 */
export function loadAnthropicPortalConfig(env: NodeJS.ProcessEnv = process.env): AnthropicPortalConfig | undefined {
  const url = env[ANTHROPIC_PORTAL_ENV.url];
  const credentialFile = env[ANTHROPIC_PORTAL_ENV.credentialFile];
  if (!url && !credentialFile) return undefined;
  if (!url) throw new Error(`${ANTHROPIC_PORTAL_ENV.url} must be set when ${ANTHROPIC_PORTAL_ENV.credentialFile} is`);
  if (!credentialFile) throw new Error(`${ANTHROPIC_PORTAL_ENV.credentialFile} must be set when ${ANTHROPIC_PORTAL_ENV.url} is`);
  try {
    new URL(url);
  } catch {
    throw new Error(`${ANTHROPIC_PORTAL_ENV.url} is not a valid URL`);
  }
  if (!existsSync(credentialFile)) throw new Error(`portal credential file ${credentialFile} does not exist`);
  const credential = readFileSync(credentialFile, "utf8").trim();
  if (!credential) throw new Error(`portal credential file ${credentialFile} is empty`);
  return { url, credential };
}

export type PortalReadErrorKind = "authentication" | "http" | "network" | "format";

/** A read that could not see the portal. Its message never carries the credential. */
export class PortalReadError extends Error {
  readonly kind: PortalReadErrorKind;
  readonly status: number | undefined;

  constructor(kind: PortalReadErrorKind, message: string, status?: number) {
    super(message);
    this.name = "PortalReadError";
    this.kind = kind;
    this.status = status;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AnthropicPortalReaderOptions extends AnthropicPortalConfig {
  /** Replaced in tests by a replay of recorded portal responses. */
  fetch?: FetchLike;
  /** Abort the read after this long (default 30s). */
  timeout_ms?: number;
}

export class AnthropicPortalReader {
  readonly url: string;
  readonly #credential: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: AnthropicPortalReaderOptions) {
    if (!options.credential) throw new Error("the portal credential is empty");
    this.url = options.url;
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeout_ms ?? 30_000;
  }

  /** Reads the portal once. Bound, so it can be passed as PortalReadConfig.read. */
  readonly read = async (): Promise<PortalObservation[]> => {
    try {
      return await this.#read();
    } catch (err) {
      throw this.#scrubbed(err);
    }
  };

  async #read(): Promise<PortalObservation[]> {
    let response: Response;
    try {
      response = await this.#fetch(this.url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.#credential}`, accept: "application/json" },
        // A redirect is the portal sending us to its login page: an auth failure, not something to follow.
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new PortalReadError("network", `anthropic portal read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const { status } = response;
    // The body is never quoted into an error: the portal may echo the credential.
    if (status === 401 || status === 403 || (status >= 300 && status < 400) || response.type === "opaqueredirect") {
      await response.body?.cancel();
      throw new PortalReadError("authentication", `anthropic portal authentication failed (HTTP ${status}): the credential was rejected`, status);
    }
    if (status < 200 || status >= 300) {
      await response.body?.cancel();
      throw new PortalReadError("http", `anthropic portal read failed (HTTP ${status})`, status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PortalReadError("format", "anthropic portal response is not JSON", status);
    }
    return parseListings(body);
  }

  /** Any error leaving the reader is a PortalReadError with the credential removed. */
  #scrubbed(err: unknown): PortalReadError {
    const scrub = (text: string) => text.replaceAll(this.#credential, "[redacted]");
    if (err instanceof PortalReadError) {
      if (!err.message.includes(this.#credential)) return err;
      return new PortalReadError(err.kind, scrub(err.message), err.status);
    }
    return new PortalReadError("network", scrub(`anthropic portal read failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** The portal's listings payload → one observation per listing. */
export function parseListings(body: unknown): PortalObservation[] {
  const listings = isRecord(body) ? body["listings"] : undefined;
  if (!Array.isArray(listings)) throw new PortalReadError("format", "anthropic portal response has no listings array");
  const seen = new Set<string>();
  return listings.map((entry, i) => {
    if (!isRecord(entry)) throw new PortalReadError("format", `anthropic portal listing ${i} is not an object`);
    const { slug, status } = entry;
    if (typeof slug !== "string" || slug === "") throw new PortalReadError("format", `anthropic portal listing ${i} has no slug`);
    if (typeof status !== "string" || status === "") throw new PortalReadError("format", `anthropic portal listing ${slug} has no status`);
    if (seen.has(slug)) throw new PortalReadError("format", `anthropic portal lists ${slug} more than once`);
    seen.add(slug);
    const fields: Record<string, unknown> = {};
    for (const key of ["name", "version", "updated_at"] as const) {
      if (typeof entry[key] === "string") fields[key] = entry[key];
    }
    return { subject: slug, status, fields };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
