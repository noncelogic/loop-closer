// LC-ESTATE-IMAGE-RUNNER acceptance: .github/workflows/estate-image.yml runs
// on a runner noncelogic/loop-closer can actually use, so a push to main
// publishes loopcloser:sha-<commit> instead of queueing forever.
//
// The passband-ci ARC scale set is registered only for noncelogic/loopmentum
// (meta-harness devops/aks/ci-runners/README.md); estate-image runs that asked
// for it never started (run 44147944903 queued from 2026-11-17T18:26Z, later
// runs cancelled behind it in the `estate-image` concurrency group).
// loop-closer has no self-hosted runner of its own, so its workflows run on
// GitHub-hosted runners, as ci.yml does. Static check of the workflow files:
// nothing here reaches GitHub, a runner or a registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const WORKFLOWS = join(repoRoot, ".github", "workflows");
type Obj = Record<string, any>;

// Runner labels registered only for another repository's runners. A job that
// asks for any of them never starts in loop-closer.
const OTHER_REPO_ONLY_LABELS = ["passband-ci", "aks"];

// GitHub-hosted Linux labels: available to every repository in the org.
const GITHUB_HOSTED_LINUX = /^ubuntu-(latest|\d{2}\.04)(-arm)?$/;

function load(file: string): Obj {
  return parse(readFileSync(join(WORKFLOWS, file), "utf8")) as Obj;
}

function labels(job: Obj): unknown[] {
  const runsOn = job["runs-on"];
  return Array.isArray(runsOn) ? runsOn : [runsOn];
}

/** Why a job's runs-on is not one loop-closer can use, or null when it is. */
function unavailable(job: Obj): string | null {
  const ls = labels(job);
  if (ls.length === 0 || ls[0] === undefined) return "no runs-on";
  for (const l of ls) {
    if (typeof l !== "string") return `label ${JSON.stringify(l)} is not a literal string`;
    if (l.includes("${{")) return `label ${l} is computed`;
    if (OTHER_REPO_ONLY_LABELS.includes(l)) return `label ${l} is registered only for another repository`;
  }
  if (ls.includes("self-hosted")) return "loop-closer has no self-hosted runner registered";
  if (ls.length !== 1 || !GITHUB_HOSTED_LINUX.test(String(ls[0]))) {
    return `runs-on ${JSON.stringify(job["runs-on"])} is not a single GitHub-hosted Linux label`;
  }
  return null;
}

test("the estate image job targets a runner label available to loop-closer", () => {
  const wf = load("estate-image.yml");
  const jobs = wf["jobs"] as Obj;
  assert.ok(Object.keys(jobs).length > 0, "the estate image workflow has jobs");
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(unavailable(job as Obj), null, `job ${name}: ${unavailable(job as Obj)}`);
  }

  // Same runner family as loop-closer's ci, whose jobs do start.
  const ci = load("ci.yml");
  const ciLabels = new Set(Object.values(ci["jobs"] as Obj).flatMap((j) => labels(j as Obj)));
  for (const [name, job] of Object.entries(jobs)) {
    for (const l of labels(job as Obj)) {
      assert.ok(ciLabels.has(l), `job ${name}: label ${String(l)} is one ci.yml already runs on (${[...ciLabels].join(", ")})`);
    }
  }

  // Image pushes stay serialised without cancelling a run in progress, in a
  // fresh group (estate-image-hosted-v1): the old `estate-image` group is
  // still held by run 44147944903, queued for the passband-ci label that no
  // longer exists, so every hosted run waiting in that group was cancelled.
  assert.deepEqual(wf["concurrency"], { group: "estate-image-hosted-v1", "cancel-in-progress": false });
  // Publication stays main-only.
  assert.deepEqual(Object.keys(wf["on"] as Obj), ["push"]);
  assert.deepEqual((wf["on"] as Obj)["push"], { branches: ["main"] });
});

test("a job that targets a runner label registered only for another repository is caught", () => {
  for (const runsOn of [
    ["self-hosted", "passband-ci"],
    ["self-hosted", "passband-ci", "aks"],
    "passband-ci",
    ["self-hosted", "linux"],
    "${{ vars.RUNNER }}",
    ["ubuntu-latest", "passband-ci"],
  ]) {
    assert.notEqual(unavailable({ "runs-on": runsOn }), null, `runs-on ${JSON.stringify(runsOn)} is rejected`);
  }
  assert.equal(unavailable({ "runs-on": "ubuntu-latest" }), null);
  assert.equal(unavailable({ "runs-on": "ubuntu-24.04" }), null);
});

// LC-EST-IMAGE-PUBLISH acceptance: the publish job logs in to the estate
// registry with loop-closer's own least-privilege push credential, custodied
// in OpenBao at kv/loop-closer/registry-push (Rule:
// policies/placement-defaults.yaml#credentials), beside the repository
// variable ESTATE_REGISTRY; never with repository secrets. ci.yml's
// estate-image-inputs job is its pull-request dry run (policy
// main-stays-green): the same script validates the same inputs and reads only
// the credential's metadata. Both run the real script against a local stand-in
// for the GitHub OIDC endpoint and OpenBao, with a stub `docker`.
const CREDENTIAL_PATH = "kv/loop-closer/registry-push";
const SCRIPT_REL = ".github/scripts/estate-registry-credential.mjs";
const SCRIPT = join(repoRoot, SCRIPT_REL);
const PUSH_ROLE = "loop-closer-registry-push";
const CHECK_ROLE = "loop-closer-registry-push-check";
const READ_DATA_POLICY = 'path "kv/data/loop-closer/registry-push" {\n  capabilities = ["read"]\n}\n';
// Grants only the metadata: the credential exists but the publish cannot read it.
const METADATA_ONLY_POLICY = 'path "kv/metadata/loop-closer/registry-push" {\n  capabilities = ["read"]\n}\n';

interface FakeOpts {
  roles?: readonly string[];
  credential?: Record<string, string> | null;
  /** ACL policy text of the publish role; the credential read honours it. */
  pushPolicy?: string;
  /** Whether that policy really lets the publish read the credential (default: it is READ_DATA_POLICY). */
  pushCanRead?: boolean;
}
interface Fake {
  url: string;
  requests: { method: string; path: string; role?: string; token?: string }[];
  close(): Promise<void>;
}

async function fakeEstate(opts: FakeOpts = {}): Promise<Fake> {
  const roles = opts.roles ?? [PUSH_ROLE, CHECK_ROLE];
  const credential = opts.credential === undefined ? { username: "lc-push", password: "s3cret-push-token" } : opts.credential;
  const pushPolicy = opts.pushPolicy ?? READ_DATA_POLICY;
  const pushCanRead = opts.pushCanRead ?? pushPolicy === READ_DATA_POLICY;
  const requests: Fake["requests"] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://x");
      const token = req.headers["x-vault-token"] as string | undefined;
      const entry: Fake["requests"][number] = { method: req.method ?? "", path: u.pathname };
      if (token) entry.token = token;
      requests.push(entry);
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (u.pathname === "/oidc") {
        if (req.headers["authorization"] !== "bearer runner-request-token" || u.searchParams.get("audience") !== "openbao") return send(403, {});
        return send(200, { value: "github-oidc-jwt" });
      }
      if (u.pathname === "/v1/auth/jwt/login" && req.method === "POST") {
        const body = JSON.parse(raw) as { role: string; jwt: string };
        entry.role = body.role;
        if (body.jwt !== "github-oidc-jwt" || !roles.includes(body.role)) return send(400, { errors: [`role "${body.role}" could not be found`] });
        return send(200, { auth: { client_token: `token-${body.role}` } });
      }
      if (u.pathname === "/v1/kv/data/loop-closer/registry-push") {
        if (token !== `token-${PUSH_ROLE}` || !pushCanRead) return send(403, { errors: ["permission denied"] });
        if (!credential) return send(404, { errors: [] });
        return send(200, { data: { data: credential, metadata: { version: 2 } } });
      }
      if (u.pathname === "/v1/kv/metadata/loop-closer/registry-push") {
        if (token !== `token-${CHECK_ROLE}` && token !== `token-${PUSH_ROLE}`) return send(403, { errors: ["permission denied"] });
        if (!credential) return send(404, { errors: [] });
        return send(200, { data: { current_version: 2, versions: { "1": { deletion_time: "", destroyed: false }, "2": { deletion_time: "", destroyed: false } } } });
      }
      // The check role may read the publish role's configuration and policy
      // text (never the credential), the publish role may not.
      if (u.pathname === `/v1/auth/jwt/role/${PUSH_ROLE}`) {
        if (token !== `token-${CHECK_ROLE}`) return send(403, { errors: ["permission denied"] });
        if (!roles.includes(PUSH_ROLE)) return send(404, { errors: [] });
        return send(200, { data: { token_policies: [PUSH_ROLE] } });
      }
      if (u.pathname === `/v1/sys/policies/acl/${PUSH_ROLE}`) {
        if (token !== `token-${CHECK_ROLE}`) return send(403, { errors: ["permission denied"] });
        return send(200, { data: { name: PUSH_ROLE, policy: pushPolicy } });
      }
      return send(404, { errors: [] });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(() => r())) };
}

/** A `docker` stub on PATH that records its arguments and stdin. */
function dockerStub(): { dir: string; record: string } {
  const dir = mkdtempSync(join(tmpdir(), "lc-docker-stub-"));
  const record = join(dir, "calls");
  writeFileSync(join(dir, "docker"), `#!/usr/bin/env bash\nprintf 'args:%s\\n' "$*" >> "${record}"\nprintf 'stdin:%s\\n' "$(cat)" >> "${record}"\n`);
  chmodSync(join(dir, "docker"), 0o755);
  return { dir, record };
}

function runScript(mode: string, env: Record<string, string | undefined>, pathPrefix: string): Promise<{ status: number | null; output: string }> {
  const base: Record<string, string> = { PATH: `${pathPrefix}:${process.env["PATH"]}`, OPENBAO_RETRY_DELAY_MS: "10" };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) base[k] = v;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, mode], { cwd: repoRoot, env: base });
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    child.on("close", (status) => resolve({ status, output }));
  });
}

function runnerEnv(fake: Fake): Record<string, string> {
  return {
    ESTATE_REGISTRY: "registry.estate.example",
    OPENBAO_ADDR: fake.url,
    ACTIONS_ID_TOKEN_REQUEST_URL: `${fake.url}/oidc?api-version=2.0`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
  };
}

function scriptStep(job: Obj, mode: string): Obj {
  const step = ((job["steps"] ?? []) as Obj[]).find((s) => String(s["run"] ?? "").trim() === `node ${SCRIPT_REL} ${mode}`);
  assert.ok(step, `the job runs \`node ${SCRIPT_REL} ${mode}\``);
  return step;
}

// COND-240-merge1: the merge of main kept both sides of the publish job: the
// OpenBao-backed login (this item) and main's pushed-digest record
// (LC-EST-IMAGE-READY), with the registry logout last so it runs after both.
test("the publish job keeps the OpenBao login, main's pushed-digest record and a final registry logout", () => {
  const steps = ((load("estate-image.yml")["jobs"] as Obj)["publish"] as Obj)["steps"] as Obj[];
  const login = steps.indexOf(scriptStep({ steps }, "login"));
  const push = steps.findIndex((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@"));
  const record = steps.findIndex((s) => s["name"] === "Record pushed digest");
  const logout = steps.findIndex((s) => String(s["run"] ?? "").startsWith("docker logout"));
  assert.ok(login >= 0 && push > login && record > push && logout > record, "login, push, record digest, then logout");
  assert.equal(steps[push]!["id"], "push");
  assert.deepEqual(steps[record]!["env"], { DIGEST: "${{ steps.push.outputs.digest }}", IMAGE: "${{ vars.ESTATE_REGISTRY }}/loopcloser" });
  assert.equal(steps[logout]!["if"], "always()");
  assert.equal(logout, steps.length - 1, "the logout is the last step");
});

test("the publish job reads the registry push credential from the loop-closer OpenBao path, never from repository secrets", async () => {
  const text = readFileSync(join(WORKFLOWS, "estate-image.yml"), "utf8");
  const wf = parse(text) as Obj;
  assert.ok(!/\bsecrets\./.test(text), "the estate image workflow reads no repository secret");
  assert.ok(!/secrets\s*:\s*inherit/.test(text), "the workflow never inherits secrets");
  const job = (wf["jobs"] as Obj)["publish"] as Obj;
  assert.ok(job, "the workflow has the publish job");
  assert.deepEqual(job["permissions"], { contents: "read", "id-token": "write" }, "OIDC for the OpenBao login; nothing else");
  const steps = job["steps"] as Obj[];
  assert.ok(!steps.some((s) => String(s["uses"] ?? "").startsWith("docker/login-action@")), "no login from repository secrets");
  const login = scriptStep(job, "login");
  assert.deepEqual(login["env"], { ESTATE_REGISTRY: "${{ vars.ESTATE_REGISTRY }}", OPENBAO_ADDR: "${{ vars.OPENBAO_ADDR }}" });
  const loginIdx = steps.indexOf(login);
  const buildIdx = steps.findIndex((s) => String(s["uses"] ?? "").startsWith("docker/build-push-action@"));
  assert.ok(loginIdx >= 0 && buildIdx > loginIdx, "the push comes after the OpenBao-backed registry login");
  assert.equal((steps[buildIdx]!["with"] as Obj)["tags"], "${{ vars.ESTATE_REGISTRY }}/loopcloser:sha-${{ github.sha }}");
  assert.ok(readFileSync(SCRIPT, "utf8").includes(`"${CREDENTIAL_PATH}"`), `the script reads ${CREDENTIAL_PATH}`);

  // The real path: the script logs in with the job's OIDC token as the push
  // role, reads exactly kv/loop-closer/registry-push and hands the password to
  // docker on stdin, never as an argument.
  const fake = await fakeEstate();
  const docker = dockerStub();
  try {
    const r = await runScript("login", runnerEnv(fake), docker.dir);
    assert.equal(r.status, 0, r.output);
    assert.ok(r.output.includes("::add-mask::s3cret-push-token"), "the password is masked in the log");
    assert.deepEqual(
      fake.requests.map((q) => `${q.method} ${q.path}${q.role ? ` ${q.role}` : ""}`),
      ["GET /oidc", `POST /v1/auth/jwt/login ${PUSH_ROLE}`, "GET /v1/kv/data/loop-closer/registry-push"],
    );
    const calls = readFileSync(docker.record, "utf8");
    assert.equal(calls, "args:login registry.estate.example --username lc-push --password-stdin\nstdin:s3cret-push-token\n");

    // A credential without its password never reaches docker.
    const empty = await fakeEstate({ credential: { username: "lc-push" } });
    const r2 = await runScript("login", runnerEnv(empty), docker.dir);
    await empty.close();
    assert.notEqual(r2.status, 0);
    assert.match(r2.output, /::error::OpenBao push credential kv\/loop-closer\/registry-push is unreachable: it has no password property/);
    assert.equal(readFileSync(docker.record, "utf8"), calls, "docker login was not called again");
  } finally {
    await fake.close();
    rmSync(docker.dir, { recursive: true, force: true });
  }
});

test("the pull-request dry run fails naming the missing input when the registry variable or push credential is unreachable", async () => {
  const ci = load("ci.yml");
  assert.ok("pull_request" in (ci["on"] as Obj) && !("pull_request_target" in (ci["on"] as Obj)), "ci.yml runs on plain pull_request");
  const job = (ci["jobs"] as Obj)["estate-image-inputs"] as Obj;
  assert.ok(job, "ci.yml has the estate-image-inputs job");
  assert.equal(job["if"], undefined, "it runs on every event, pull requests included");
  assert.equal(unavailable(job), null);
  assert.deepEqual(job["permissions"], { contents: "read", "id-token": "write" });
  const check = scriptStep(job, "check");
  const publishLogin = scriptStep((load("estate-image.yml")["jobs"] as Obj)["publish"] as Obj, "login");
  assert.deepEqual(check["env"], publishLogin["env"], "the dry run validates the same inputs as the publish");
  assert.ok(!/secrets\./.test(JSON.stringify(job)), "the dry run reads no repository secret");

  const docker = dockerStub();
  const fake = await fakeEstate();
  try {
    // Everything reachable: passes, and reads only the metadata and the
    // publish role's grants, never the credential.
    const ok = await runScript("check", runnerEnv(fake), docker.dir);
    assert.equal(ok.status, 0, ok.output);
    assert.deepEqual(
      fake.requests.map((q) => `${q.method} ${q.path}${q.role ? ` ${q.role}` : ""}`),
      [
        "GET /oidc",
        `POST /v1/auth/jwt/login ${CHECK_ROLE}`,
        "GET /v1/kv/metadata/loop-closer/registry-push",
        `GET /v1/auth/jwt/role/${PUSH_ROLE}`,
        `GET /v1/sys/policies/acl/${PUSH_ROLE}`,
      ],
    );
    assert.ok(!fake.requests.some((q) => q.path.startsWith("/v1/kv/data/")), "the dry run never reads the credential");

    // Metadata readable but the publish's credential read denied: the dry run
    // fails exactly where the publish login would.
    const denied = await fakeEstate({ pushPolicy: METADATA_ONLY_POLICY });
    try {
      const login = await runScript("login", runnerEnv(denied), docker.dir);
      assert.notEqual(login.status, 0, "the publish login cannot read the credential");
      assert.match(login.output, /read of kv\/loop-closer\/registry-push failed: HTTP 403/);
      denied.requests.length = 0;
      const r = await runScript("check", runnerEnv(denied), docker.dir);
      assert.notEqual(r.status, 0, `metadata readable, credential read denied: the dry run fails: ${r.output}`);
      assert.match(
        r.output,
        /::error::OpenBao push credential kv\/loop-closer\/registry-push is unreachable: role loop-closer-registry-push cannot read it/,
      );
      assert.ok(denied.requests.some((q) => q.path === "/v1/kv/metadata/loop-closer/registry-push"), "the metadata read succeeded first");
      assert.ok(!denied.requests.some((q) => q.path.startsWith("/v1/kv/data/")), "the dry run still never reads the credential");
    } finally {
      await denied.close();
    }

    // Commented-out grants are not grants: with only metadata access and the
    // data grant commented out, the publish login gets HTTP 403, so the dry
    // run must fail too.
    for (const commented of [
      `${METADATA_ONLY_POLICY}# path "kv/data/loop-closer/registry-push" { capabilities = ["read"] }\n`,
      `${METADATA_ONLY_POLICY}// path "kv/data/loop-closer/registry-push" { capabilities = ["read"] }\n`,
      `${METADATA_ONLY_POLICY}/*\npath "kv/data/loop-closer/registry-push" {\n  capabilities = ["read"]\n}\n*/\n`,
      `path "kv/data/loop-closer/registry-push" {\n  # capabilities = ["read"]\n  capabilities = ["list"]\n}\n`,
    ]) {
      const f = await fakeEstate({ pushPolicy: commented, pushCanRead: false });
      try {
        const login = await runScript("login", runnerEnv(f), docker.dir);
        assert.notEqual(login.status, 0, "the publish login cannot read the credential");
        assert.match(login.output, /read of kv\/loop-closer\/registry-push failed: HTTP 403/);
        const r = await runScript("check", runnerEnv(f), docker.dir);
        assert.notEqual(r.status, 0, `commented-out grant: the dry run fails: ${commented}\n${r.output}`);
        assert.match(
          r.output,
          /::error::OpenBao push credential kv\/loop-closer\/registry-push is unreachable: role loop-closer-registry-push cannot read it/,
        );
      } finally {
        await f.close();
      }
    }

    // A real grant beside comments (including `#` and `//` inside strings) still
    // passes; policy text that cannot be parsed fails closed.
    const commentedPolicy =
      '# publish role\n/* least privilege */\npath "kv/data/loop-closer/registry-push" { // the credential\n  capabilities = ["read", ] # only read\n}\n' +
      'path "kv/metadata/a#b//c" {\n  capabilities = ["read"]\n}\n';
    const withComments = await fakeEstate({ pushPolicy: commentedPolicy, pushCanRead: true });
    try {
      const r = await runScript("check", runnerEnv(withComments), docker.dir);
      assert.equal(r.status, 0, r.output);
    } finally {
      await withComments.close();
    }
    const unparseable = await fakeEstate({ pushPolicy: 'path "kv/data/loop-closer/registry-push" {\n  capabilities = ["read"]\n', pushCanRead: true });
    try {
      const r = await runScript("check", runnerEnv(unparseable), docker.dir);
      assert.notEqual(r.status, 0, r.output);
      assert.match(r.output, /::error::OpenBao push credential kv\/loop-closer\/registry-push is unreachable: OpenBao policy loop-closer-registry-push could not be parsed/);
    } finally {
      await unparseable.close();
    }
    rmSync(docker.record, { force: true });

    const cases: [string, Record<string, string | undefined>, RegExp][] = [
      ["registry variable unset", { ...runnerEnv(fake), ESTATE_REGISTRY: "" }, /::error::repository variable ESTATE_REGISTRY is not set/],
      ["OpenBao address unset", { ...runnerEnv(fake), OPENBAO_ADDR: undefined }, /::error::repository variable OPENBAO_ADDR is not set/],
      [
        "no OIDC token",
        { ...runnerEnv(fake), ACTIONS_ID_TOKEN_REQUEST_URL: undefined },
        /::error::OpenBao push credential kv\/loop-closer\/registry-push is unreachable: GitHub OIDC token is unavailable/,
      ],
      [
        "OpenBao down",
        { ...runnerEnv(fake), OPENBAO_ADDR: "http://127.0.0.1:1" },
        /::error::OpenBao push credential kv\/loop-closer\/registry-push is unreachable: OpenBao login as role loop-closer-registry-push-check failed/,
      ],
    ];
    for (const [what, env, expected] of cases) {
      const r = await runScript("check", env, docker.dir);
      assert.notEqual(r.status, 0, `${what}: the dry run fails`);
      assert.match(r.output, expected, `${what}: ${r.output}`);
    }

    for (const [what, opts] of [["role missing", { roles: [PUSH_ROLE] }], ["credential not written", { credential: null }]] as const) {
      const f = await fakeEstate(opts);
      const r = await runScript("check", runnerEnv(f), docker.dir);
      await f.close();
      assert.notEqual(r.status, 0, `${what}: the dry run fails`);
      assert.match(r.output, /::error::OpenBao push credential kv\/loop-closer\/registry-push is unreachable: /, `${what}: ${r.output}`);
    }
    assert.ok(!existsSync(docker.record), "the dry run never logs in to the registry");
  } finally {
    await fake.close();
    rmSync(docker.dir, { recursive: true, force: true });
  }
});
