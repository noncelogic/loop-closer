// LC-EST-IMAGE-INPUTS-CHECK acceptance: ci.yml's estate-image-inputs job, the
// pull-request dry run of estate-image.yml's main-only publish, checks every
// input the publish job reads (repository variables ESTATE_REGISTRY and
// OPENBAO_ADDR, the OpenBao JWT dry-run role loop-closer-registry-push-check
// and the metadata of kv/loop-closer/registry-push) without pushing, and fails
// with the name of the first missing input. Run 44277465574's publish failed
// on main on absent registry inputs; with this, the pull request fails first.
// Rule: policies/placement-defaults.yaml#credentials: the dry-run role reads
// only metadata and role config, never the secret value.
//
// The publish job's inputs are taken from estate-image.yml itself, so an input
// added there that the dry run does not pass fails here. The real script runs
// against a local stand-in for GitHub OIDC and OpenBao that fails any request
// it does not expect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const WORKFLOWS = join(repoRoot, ".github", "workflows");
const SCRIPT_REL = ".github/scripts/estate-registry-credential.mjs";
const CHECK_ROLE = "loop-closer-registry-push-check";
const PUSH_ROLE = "loop-closer-registry-push";
const METADATA = "kv/loop-closer/registry-push";
type Obj = Record<string, any>;

function load(file: string): Obj {
  return parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Obj;
}

/** Every `${{ vars.X }}` / `${{ secrets.X }}` the job reads, as "vars.X" / "secrets.X". */
function contextInputs(job: Obj): Set<string> {
  const found = new Set<string>();
  for (const m of JSON.stringify(job).matchAll(/\$\{\{[^}]*?\b(vars|secrets)\.([A-Za-z0-9_]+)/g)) found.add(`${m[1]}.${m[2]}`);
  return found;
}

interface Estate {
  checkRole: boolean;
  metadata: boolean;
}
interface Fake {
  url: string;
  requests: string[];
  unexpected: string[];
  close(): Promise<void>;
}

/** GitHub OIDC plus OpenBao, answering only the dry run's routes; anything else is recorded and fails. */
async function fakeEstate(estate: Estate): Promise<Fake> {
  const requests: string[] = [];
  const unexpected: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      const key = `${req.method} ${u.pathname}`;
      requests.push(key);
      const token = req.headers["x-vault-token"];
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const checkToken = token === `token-${CHECK_ROLE}`;
      switch (key) {
        case "GET /oidc":
          if (req.headers["authorization"] !== "bearer runner-request-token" || u.searchParams.get("audience") !== "openbao") return send(403, {});
          return send(200, { value: "github-oidc-jwt" });
        case "POST /v1/auth/jwt/login": {
          const body = JSON.parse(raw) as { role: string; jwt: string };
          if (body.jwt !== "github-oidc-jwt" || body.role !== CHECK_ROLE || !estate.checkRole) {
            return send(400, { errors: [`role "${body.role}" could not be found`] });
          }
          return send(200, { auth: { client_token: `token-${CHECK_ROLE}` } });
        }
        case `GET /v1/kv/metadata/${METADATA.slice(3)}`:
          if (!checkToken) return send(403, { errors: ["permission denied"] });
          if (!estate.metadata) return send(404, { errors: [] });
          return send(200, { data: { current_version: 1, versions: { "1": { deletion_time: "", destroyed: false } } } });
        case `GET /v1/auth/jwt/role/${PUSH_ROLE}`:
          if (!checkToken) return send(403, { errors: ["permission denied"] });
          return send(200, { data: { token_policies: [PUSH_ROLE] } });
        case `GET /v1/sys/policies/acl/${PUSH_ROLE}`:
          if (!checkToken) return send(403, { errors: ["permission denied"] });
          return send(200, { data: { policy: `path "kv/data/${METADATA.slice(3)}" {\n  capabilities = ["read"]\n}\n` } });
        default:
          // Not a route the dry run may call (the credential's data path included).
          unexpected.push(key);
          return send(418, { errors: [`unexpected request ${key}`] });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    unexpected,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Runs the dry run step's command with the env the runner would give it. */
function runCheck(command: string, env: Record<string, string>): Promise<{ status: number | null; output: string }> {
  const args = command.trim().split(/\s+/);
  assert.equal(args[0], "node");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args.slice(1), {
      cwd: repoRoot,
      env: { PATH: process.env["PATH"] ?? "", OPENBAO_RETRY_DELAY_MS: "1", ...env },
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("close", (status) => resolve({ status, output }));
  });
}

test("every input the publish job reads is checked by the pull-request dry run, which names the missing input", async () => {
  const publish = (load("estate-image.yml")["jobs"] as Obj)["publish"] as Obj;
  const dry = (load("ci.yml")["jobs"] as Obj)["estate-image-inputs"] as Obj;
  assert.ok(publish && dry, "estate-image.yml has publish and ci.yml has estate-image-inputs");

  // Every input the publish reads, from the workflow itself.
  const inputs = contextInputs(publish);
  assert.deepEqual([...inputs].filter((i) => i.startsWith("secrets.")), [], "the publish reads no repository secret");
  const vars = [...inputs].map((i) => i.replace(/^vars\./, "")).sort();
  assert.deepEqual(vars, ["ESTATE_REGISTRY", "OPENBAO_ADDR"], "the publish reads these repository variables");
  assert.deepEqual(contextInputs(dry), new Set(inputs), "the dry run reads exactly the publish's inputs");

  // The dry run step that receives them, and pushes nothing.
  const steps = (dry["steps"] ?? []) as Obj[];
  const check = steps.find((s) => String(s["run"] ?? "").trim() === `node ${SCRIPT_REL} check`);
  assert.ok(check, `the dry run runs \`node ${SCRIPT_REL} check\``);
  for (const v of vars) assert.equal((check["env"] as Obj)[v], `\${{ vars.${v} }}`, `the dry run passes ${v}`);
  assert.deepEqual(dry["permissions"], { contents: "read", "id-token": "write" }, "OIDC for the dry-run role; nothing else");
  assert.ok(!steps.some((s) => /docker\/(build-push|login)-action@/.test(String(s["uses"] ?? ""))), "the dry run builds and pushes nothing");

  // The inputs in the order the dry run checks them; making one missing (and
  // every later one with it) fails with exactly one error, naming it.
  const order = [...vars, "OIDC", CHECK_ROLE, METADATA] as const;
  const named: Record<string, RegExp> = {
    ESTATE_REGISTRY: /^::error::repository variable ESTATE_REGISTRY is not set$/,
    OPENBAO_ADDR: /^::error::repository variable OPENBAO_ADDR is not set$/,
    OIDC: /^::error::.*GitHub OIDC token is unavailable/,
    [CHECK_ROLE]: new RegExp(`^::error::.*OpenBao login as role ${CHECK_ROLE} failed`),
    [METADATA]: new RegExp(`^::error::.*read of ${METADATA} metadata failed: HTTP 404`),
  };
  for (let k = 0; k <= order.length; k++) {
    const missing = new Set(order.slice(k));
    const fake = await fakeEstate({ checkRole: !missing.has(CHECK_ROLE), metadata: !missing.has(METADATA) });
    try {
      const env: Record<string, string> = {};
      if (!missing.has("ESTATE_REGISTRY")) env["ESTATE_REGISTRY"] = "registry.estate.example";
      if (!missing.has("OPENBAO_ADDR")) env["OPENBAO_ADDR"] = fake.url;
      if (!missing.has("OIDC")) {
        env["ACTIONS_ID_TOKEN_REQUEST_URL"] = `${fake.url}/oidc?api-version=2.0`;
        env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "runner-request-token";
      }
      const r = await runCheck(String(check["run"]), env);
      const errors = r.output.split("\n").filter((l) => l.startsWith("::error::"));
      if (k === order.length) {
        assert.equal(r.status, 0, `every input present: the dry run passes\n${r.output}`);
        assert.deepEqual(errors, []);
        assert.deepEqual(fake.requests, [
          "GET /oidc",
          "POST /v1/auth/jwt/login",
          `GET /v1/kv/metadata/${METADATA.slice(3)}`,
          `GET /v1/auth/jwt/role/${PUSH_ROLE}`,
          `GET /v1/sys/policies/acl/${PUSH_ROLE}`,
        ], "the dry run reads only metadata and role config, never the credential");
      } else {
        const first = order[k]!;
        assert.notEqual(r.status, 0, `${first} missing: the dry run fails\n${r.output}`);
        assert.equal(errors.length, 1, `${first} missing: one error, for the first missing input\n${r.output}`);
        assert.match(errors[0]!, named[first]!, `${first} missing: the error names it\n${r.output}`);
        for (const later of order.slice(k + 1)) {
          if (vars.includes(later)) assert.ok(!errors[0]!.includes(later), `the error names ${first}, not ${later}`);
        }
      }
      assert.deepEqual(fake.unexpected, [], "the dry run made no request outside its routes");
    } finally {
      await fake.close();
    }
  }
});
