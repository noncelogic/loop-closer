// HTTP surface of the loopcloser service: GET /healthz, plus the loop and
// communication operations of the frozen API contract (contracts/openapi.json,
// served under /v1) answered through the kernel. Every request body and query is checked
// against the contract before the kernel sees it, and every response body is
// checked against the contract before it is sent: a response that would not
// validate is replaced by a 500, never returned.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { B3_OPERATIONS, createApiValidator, type ApiValidator } from "./contracts/index.ts";
import { InMemoryGraphStore, Kernel, KernelError } from "./kernel/index.ts";
import type {
  ApproveSendInput,
  FireEventInput,
  LedgerEvent,
  Loop,
  LoopState,
  OpenLoopsFilter,
  ProposeLoopInput,
  RecordCommunicationInput,
  RequestSendInput,
  TransitionInput,
} from "./kernel/index.ts";

export const SERVICE_NAME = "loopcloser";
/** The contract's `servers[0].url`. */
export const API_PREFIX = "/v1";
const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerOptions {
  /** The kernel the operations run through; defaults to one over an in-memory store. */
  kernel?: Kernel;
  /** Agent principal → API key (the `loopcloser-api-keys` secret). No keys: every API call is 401. */
  apiKeys?: ReadonlyMap<string, string>;
  /**
   * Agent principal → the operationIds it may call (src/config.ts loadApiScopes).
   * Deny by default: a principal without an entry is refused every operation
   * (403). Joe's principal holds every scope.
   */
  scopes?: ReadonlyMap<string, Iterable<string>>;
}

type Json = Record<string, unknown>;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface Reply {
  status: number;
  body: unknown;
}

interface Route {
  operationId: string;
  /**
   * A restriction beyond the principal's scope set, which is checked first for
   * every operation; approve_send stays Joe's alone whatever the data grants.
   */
  allow?: (principal: string) => boolean;
  /** The request-body field naming who acts; it must be the authenticated principal. */
  actorField?: string;
  method: "GET" | "POST";
  /** Matches the path after the API prefix; captures the loop_id / communication_id path parameter. */
  pattern: RegExp;
  /** Query parameters the contract declares for the operation. */
  query?: readonly string[];
  handle(ctx: Context): Promise<Reply>;
}

interface Context {
  params: string[];
  query: Map<string, string>;
  body: unknown;
}

/**
 * Joe's own principal (TECH-STACK §9: Joe's access is a key like any agent's,
 * with full scope). Only Joe releases a send under joe-approves-each.
 */
export const JOE_PRINCIPAL = "joe";
const isJoe = (principal: string): boolean => principal === JOE_PRINCIPAL;

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

function authenticate(header: string | undefined, keys: readonly { principal: string; digest: Buffer }[]): string | undefined {
  if (!header) return undefined;
  const presented = digest(header.replace(/^Bearer\s+/i, "").trim());
  let principal: string | undefined;
  for (const k of keys) if (timingSafeEqual(presented, k.digest)) principal ??= k.principal;
  return principal;
}

/** ISO 8601 duration in weeks/days/hours/minutes/seconds (years and months have no fixed length). */
function durationSeconds(window: string): number | undefined {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(window);
  if (!m || window === "P" || window.endsWith("T")) return undefined;
  const [w, d, h, min, s] = m.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number];
  return w * 604800 + d * 86400 + h * 3600 + min * 60 + s;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(400, "bad_request", "request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "bad_request", "request body is not valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function kernelReply(err: KernelError): Reply {
  const status = { bad_request: 400, not_found: 404, conflict: 409, duplicate_loop: 409 }[err.code];
  if (err.code === "duplicate_loop") {
    const ids = (err.details as { existing_loop_ids?: unknown } | undefined)?.existing_loop_ids;
    return { status, body: { error: "duplicate_loop", message: err.message, existing_loop_ids: ids } };
  }
  return { status, body: { error: err.code, message: err.message } };
}

const CLOSED_STATES: ReadonlySet<LoopState> = new Set(["closed", "closed_with_reason"]);

/**
 * The loop as a transition event left it. A transition changes only state,
 * closed_at and close_reason; closed states are terminal, so a loop that this
 * event closed still carries the close_reason it was given.
 */
function loopAfter(current: Loop, event: LedgerEvent): Loop {
  const to = event.payload["to_state"] as LoopState;
  return {
    ...current,
    state: to,
    closed_at: CLOSED_STATES.has(to) ? event.at : null,
    close_reason: to === "closed_with_reason" ? current.close_reason : null,
  };
}

function routes(kernel: Kernel, api: ApiValidator): Route[] {
  const id = "(lc_[A-Za-z0-9][A-Za-z0-9_-]*)";
  const param = (operationId: string, name: string, raw: string): string => {
    const validate = api.parameter(operationId, name);
    if (validate && !validate(raw)) throw new HttpError(400, "bad_request", `${name}: ${api.ajv.errorsText(validate.errors)}`);
    return raw;
  };
  return [
    {
      operationId: "propose_loop",
      method: "POST",
      pattern: /^\/loops\/propose$/,
      handle: async ({ body }) => ({ status: 201, body: await kernel.proposeLoop(body as ProposeLoopInput) }),
    },
    {
      operationId: "accept_loop",
      method: "POST",
      pattern: new RegExp(`^/loops/${id}/accept$`),
      handle: async ({ params, body }) => ({ status: 200, body: await kernel.acceptLoop(params[0]!, body as { acceptor: string }) }),
    },
    {
      operationId: "reject_loop",
      method: "POST",
      pattern: new RegExp(`^/loops/${id}/reject$`),
      handle: async ({ params, body }) => ({
        status: 200,
        body: await kernel.rejectLoop(params[0]!, body as { actor: string; reason: string }),
      }),
    },
    {
      operationId: "transition",
      method: "POST",
      pattern: new RegExp(`^/loops/${id}/transition$`),
      handle: async ({ params, body }) => {
        // A replayed idempotency key is applied once (kernel) and answers with the
        // first result: the kernel hands back the first ledger event but the loop as
        // it is now, so the loop is restored to how that event left it.
        const { loop, ledger_event, applied } = await kernel.transition(params[0]!, body as TransitionInput);
        return { status: 200, body: { loop: applied ? loop : loopAfter(loop, ledger_event), ledger_event } };
      },
    },
    {
      operationId: "fire_event",
      method: "POST",
      pattern: /^\/events\/fire$/,
      handle: async ({ body }) => ({ status: 200, body: await kernel.fireEvent(body as FireEventInput) }),
    },
    {
      operationId: "record_communication",
      method: "POST",
      pattern: /^\/communications$/,
      handle: async ({ body }) => ({ status: 201, body: await kernel.recordCommunication(body as RecordCommunicationInput) }),
    },
    {
      // Under joe-approves-each this only records a pending approval (kernel).
      operationId: "request_send",
      method: "POST",
      actorField: "actor",
      pattern: new RegExp(`^/loops/${id}/send-requests$`),
      handle: async ({ params, body }) => ({ status: 202, body: await kernel.requestSend(params[0]!, body as RequestSendInput) }),
    },
    {
      operationId: "approve_send",
      method: "POST",
      allow: isJoe,
      actorField: "approver",
      pattern: new RegExp(`^/communications/${id}/approve$`),
      handle: async ({ params, body }) => ({ status: 200, body: await kernel.approveSend(params[0]!, body as ApproveSendInput) }),
    },
    {
      operationId: "open_loops",
      method: "GET",
      pattern: /^\/loops$/,
      query: ["accountable_who_id", "loop_type", "state", "breaching_only", "key_result_system", "key_result_id"],
      handle: async ({ query }) => {
        const filter: OpenLoopsFilter = {};
        const who = query.get("accountable_who_id");
        if (who !== undefined) filter.accountable_who_id = param("open_loops", "accountable_who_id", who);
        const loopType = query.get("loop_type");
        if (loopType !== undefined) filter.loop_type = param("open_loops", "loop_type", loopType);
        const state = query.get("state");
        if (state !== undefined) filter.state = param("open_loops", "state", state) as NonNullable<OpenLoopsFilter["state"]>;
        const breaching = query.get("breaching_only");
        if (breaching !== undefined) {
          if (breaching !== "true" && breaching !== "false")
            throw new HttpError(400, "bad_request", "breaching_only must be true or false");
          filter.breaching_only = breaching === "true";
        }
        const krSystem = query.get("key_result_system");
        const krId = query.get("key_result_id");
        if ((krSystem === undefined) !== (krId === undefined))
          throw new HttpError(400, "bad_request", "give both key_result_system and key_result_id, or neither");
        if (krSystem !== undefined && krId !== undefined)
          filter.key_result_ref = {
            system: param("open_loops", "key_result_system", krSystem),
            id: param("open_loops", "key_result_id", krId),
          };
        return { status: 200, body: await kernel.openLoops(filter) };
      },
    },
    {
      operationId: "what_fires_next",
      method: "GET",
      pattern: /^\/what-fires-next$/,
      query: ["loop_id", "when_id"],
      handle: async ({ query }) => {
        const loopId = query.get("loop_id");
        const whenId = query.get("when_id");
        if ((loopId === undefined) === (whenId === undefined))
          throw new HttpError(400, "bad_request", "give exactly one of loop_id or when_id");
        const q =
          loopId !== undefined
            ? { loop_id: param("what_fires_next", "loop_id", loopId) }
            : { when_id: param("what_fires_next", "when_id", whenId!) };
        return { status: 200, body: await kernel.whatFiresNext(q) };
      },
    },
    {
      operationId: "health",
      method: "GET",
      pattern: /^\/health$/,
      query: ["window"],
      handle: async ({ query }) => {
        const window = param("health", "window", query.get("window") ?? "P30D");
        const seconds = durationSeconds(window);
        if (seconds === undefined)
          throw new HttpError(400, "bad_request", `window ${JSON.stringify(window)} is not an ISO 8601 duration in weeks, days, hours, minutes or seconds`);
        return { status: 200, body: { window, ...(await kernel.health(seconds)) } };
      },
    },
  ];
}

/** HTTP surface of the loopcloser service. */
export function createServer(options: ServerOptions = {}): Server {
  const kernel = options.kernel ?? new Kernel(new InMemoryGraphStore());
  const keys = [...(options.apiKeys ?? new Map<string, string>())]
    .filter(([, key]) => key.length > 0)
    .map(([principal, key]) => ({ principal, digest: digest(key) }));
  const api = createApiValidator();
  const table = routes(kernel, api);
  const known: ReadonlySet<string> = new Set(B3_OPERATIONS);
  const scopes = new Map<string, ReadonlySet<string>>();
  for (const [principal, operations] of options.scopes ?? []) {
    const granted = new Set(operations);
    for (const op of granted)
      if (!known.has(op)) throw new Error(`scope for ${principal} names ${JSON.stringify(op)}, which is not an operation of the API contract`);
    scopes.set(principal, granted);
  }
  /** Deny by default: only Joe and principals whose scope set names the operation may call it. */
  const granted = (principal: string, operationId: string): boolean =>
    isJoe(principal) || (scopes.get(principal)?.has(operationId) ?? false);

  const write = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  /** Sends only what the contract allows for this operation and status. */
  const send = (res: ServerResponse, operationId: string, reply: Reply): void => {
    const validate = api.response(operationId, reply.status);
    if (validate && validate(reply.body)) return write(res, reply.status, reply.body);
    const why = validate ? api.ajv.errorsText(validate.errors) : `no ${reply.status} response is declared`;
    console.error(`${operationId}: response withheld, it does not match the contract: ${why}`);
    write(res, 500, { error: "internal", message: "the response did not match the API contract" });
  };

  const fail = (err: unknown): Reply => {
    if (err instanceof HttpError) return { status: err.status, body: { error: err.code, message: err.message } };
    if (err instanceof KernelError) return kernelReply(err);
    console.error(err);
    return { status: 500, body: { error: "internal", message: "internal error" } };
  };

  return createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      write(res, 200, { service: SERVICE_NAME, status: "ok" });
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      write(res, 400, { error: "bad_request", message: "the request target is not a valid URL" });
      return;
    }
    const path = url.pathname.startsWith(`${API_PREFIX}/`) ? url.pathname.slice(API_PREFIX.length) : undefined;
    let route: Route | undefined;
    let params: string[] = [];
    let pathMatched = false;
    for (const r of path === undefined ? [] : table) {
      const m = r.pattern.exec(path!);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      route = r;
      params = m.slice(1);
      break;
    }
    if (!route) {
      const [status, error] = pathMatched ? [405, "method_not_allowed"] : [404, "not_found"];
      write(res, status, { error, message: `${req.method} ${url.pathname} is not served` });
      return;
    }
    const op = route;

    void (async (): Promise<Reply> => {
      try {
        // Every operation in the contract needs the agent key (global `security: agentKey`).
        const principal = authenticate(req.headers.authorization, keys);
        if (principal === undefined)
          return { status: 401, body: { error: "unauthorized", message: "missing or unknown agent key" } };
        // Scopes are checked before the request is read, so a refused call changes nothing.
        if (!granted(principal, op.operationId) || (op.allow && !op.allow(principal)))
          return { status: 403, body: { error: "forbidden", message: `${principal} lacks the scope for ${op.operationId}` } };

        const query = new Map<string, string>();
        for (const [name, value] of url.searchParams) {
          if (!op.query?.includes(name)) throw new HttpError(400, "bad_request", `unknown query parameter ${name}`);
          if (query.has(name)) throw new HttpError(400, "bad_request", `query parameter ${name} is repeated`);
          query.set(name, value);
        }

        let body: unknown;
        const validate = api.request(op.operationId);
        if (validate) {
          body = await readBody(req);
          if (body === undefined) throw new HttpError(400, "bad_request", "a JSON request body is required");
          if (!validate(body))
            throw new HttpError(400, "bad_request", `request body does not match the contract: ${api.ajv.errorsText(validate.errors)}`);
        }
        if (op.actorField !== undefined) {
          const claimed = (body as Json)[op.actorField];
          if (claimed !== principal)
            return {
              status: 403,
              body: { error: "forbidden", message: `${op.actorField} ${JSON.stringify(claimed)} is not the authenticated principal ${principal}` },
            };
        }
        return await op.handle({ params, query, body });
      } catch (err) {
        return fail(err);
      }
    })().then((reply) => {
      if (reply.status === 500) return write(res, 500, reply.body);
      send(res, op.operationId, reply);
    });
  });
}
