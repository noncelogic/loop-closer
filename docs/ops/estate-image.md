# Estate image publish

`.github/workflows/estate-image.yml` runs on every merge to `main`. It builds
the loopcloser image on the estate's self-hosted ARC org scale set
`noncelogic-org` (`runs-on: [self-hosted, aks]`, as every `ci` job does) and pushes it to the estate registry that aks-obs-01 pulls from as
`loopcloser:sha-<commit>`, i.e.
`<ESTATE_REGISTRY>/loopcloser:sha-<full commit sha>`. The workflow never
touches a cluster: rollout is estate-side GitOps, pinning a `sha-<commit>` tag.

It used to target the estate's `passband-ci` self-hosted runners, but those
are registered only for `noncelogic/loopmentum`, so no run ever started
(LC-ESTATE-IMAGE-RUNNER). The `estate-image-hosted-v1` concurrency group
serialises pushes, without cancelling a run in progress. It replaces the old
`estate-image` group, which run 44147944903 (queued for the retired
`passband-ci` label) still holds: every hosted run that waited in that group
was cancelled behind it, so nothing was published.

The workflows then ran on GitHub-hosted runners, against policy
`no-github-hosted-runners` (Rule: policies/placement-defaults.yaml#estate), and
a GitHub-hosted runner cannot reach the estate OpenBao, so the publish could not
log in for its push credential. Since LC-EST-PUBLISH-RUNNER every job in `ci`
and `estate-image` runs on the org scale set, which serves every private
noncelogic repository; its runner image has no node, so jobs that run node set
it up with `actions/setup-node`. `tests/workflows/runners.test.ts` checks this.

The registry push credential is loop-closer's own, least privilege (push to
`loopcloser` only), per product (policy `registry-credential-per-product`),
custodied in OpenBao at `kv/loop-closer/registry-push` and created by the
DevOps route (Rule: policies/placement-defaults.yaml#credentials). The job
never reads repository secrets: `.github/scripts/estate-registry-credential.mjs`
mints the job's GitHub OIDC token, logs in to OpenBao through JWT auth and
pipes the password to `docker login --password-stdin` (LC-EST-IMAGE-PUBLISH).

This page lists configuration **by name only**. Values live in the repository
variables and in OpenBao; credentials never go in this repository.
`tests/deploy/image-workflow.test.ts` checks that this page names exactly what
the workflow reads.

## Repository variables

Set under *Settings → Secrets and variables → Actions → Variables* on
`noncelogic/loop-closer`. These are configuration, not secrets. The login step
fails with `repository variable <NAME> is not set` if any of them is empty.

| Variable | Read by | Holds |
| --- | --- | --- |
| `ESTATE_REGISTRY` | `estate-registry-credential.mjs`, `docker/build-push-action` | Registry host aks-obs-01 pulls from; the image is pushed as `<ESTATE_REGISTRY>/loopcloser:sha-<commit>` |
| `OPENBAO_ADDR` | `estate-registry-credential.mjs` | Estate OpenBao address the runner reaches (`https://…`, no trailing path) |

## OpenBao push credential

- **KV path:** `kv/loop-closer/registry-push` (KV v2, mount `kv`).
- **Properties:** `username` and `password` (a token that can push
  `loopcloser` to `ESTATE_REGISTRY` and nothing else). Other properties are
  ignored.
- **Auth:** JWT auth mount `jwt`, bound audience `openbao`, GitHub Actions
  OIDC issuer `https://token.actions.githubusercontent.com`.
  - Role `loop-closer-registry-push`: bound to
    `repo:noncelogic/loop-closer:ref:refs/heads/main`; policy grants `read`
    on `kv/data/loop-closer/registry-push` only. Used by the `publish` job.
  - Role `loop-closer-registry-push-check`: bound to repository
    `noncelogic/loop-closer` (pull requests included); policy grants `read`
    on `kv/metadata/loop-closer/registry-push`,
    `auth/jwt/role/loop-closer-registry-push` and
    `sys/policies/acl/loop-closer-registry-push` only, so the dry run proves
    the credential exists and that the publish role's policy grants `read` on
    `kv/data/loop-closer/registry-push`, without ever reading the credential.
- **Writer:** the DevOps route, through the delegated OpenBao ops AppRole, as
  for `kv/loopcloser/registry-pull` (docs/ops/registry-pull.md).

If the login fails, the step's error names the input:
`OpenBao push credential kv/loop-closer/registry-push is unreachable: <why>`.

## Pull-request dry run

The publish acts only on `main`, so every pull request proves it first: the
`ci` workflow's `estate-image-dry-run` job builds the same context and
Dockerfile on the org scale set, tags it `loopcloser:sha-<commit>`
without a registry, pushes nothing, and runs the listings-read CronJob's
command (`node dist/portal-read.js`) in the built image through
`.github/scripts/estate-image-smoke.sh`. It reads no secret and no repository
variable. `test/deploy/estate-image.test.ts` checks the job and runs the same
build and smoke check.

The `ci` workflow's `estate-image-inputs` job dry-runs the registry inputs:
it runs `estate-registry-credential.mjs check` with the same variables, logs in
to OpenBao as `loop-closer-registry-push-check`, checks
`kv/loop-closer/registry-push` has a current version and checks the
`loop-closer-registry-push` role's policies grant `read` on its data path
(none denies it). It reads no secret and
never the credential itself, and fails naming the missing input
(`ESTATE_REGISTRY`, `OPENBAO_ADDR`, the OIDC token or the credential).
`tests/ci/estate-image-workflow.test.ts` runs the script against a local
stand-in for OpenBao.

## Verifying a publish

1. Merge to `main`, then check that the `estate-image` run's `publish` job
   passes (`gh run list --workflow estate-image`).
2. If *Log in to the estate registry with the OpenBao push credential* fails,
   its error names the unset variable or the unreachable OpenBao input.
3. If `docker login` or the push fails, `kv/loop-closer/registry-push` does
   not hold a credential that can push `loopcloser` to `ESTATE_REGISTRY`.
4. Check that the registry has `loopcloser:sha-<commit>` for the merged commit.
5. Read the pushed digest, source commit and run id from the publish job's
   *Record pushed digest* step (job summary *Pushed loopcloser image*).

## Promoting a verified digest

`deploy/overlays/aks-obs-01` pins the image by digest only after that digest
has been pulled on aks-obs-01 (LC-EST-IMAGE-READY, rule
`policies/placement-defaults.yaml#estate`):

1. Take the digest from a successful publish run (above). Never type one in.
2. Through the DevOps route, pull `<ESTATE_REGISTRY>/loopcloser@<digest>` on
   aks-obs-01 in namespace `loop-closer` with the `loopcloser-registry-pull`
   Secret synced from `kv/loopcloser/registry-pull`.
3. In one change, add `deploy/overlays/aks-obs-01/image-evidence.json` and
   replace the overlay's `newTag` with `digest: <digest>`. The record holds no
   credential value:

   ```json
   {
     "image": "<ESTATE_REGISTRY>/loopcloser",
     "digest": "sha256:<pushed digest>",
     "publish": { "workflow": "estate-image", "job": "publish", "run": <run id>, "sourceCommit": "<40-hex commit>" },
     "pull": {
       "cluster": "aks-obs-01", "namespace": "loop-closer",
       "credential": "kv/loopcloser/registry-pull", "pullSecret": "loopcloser-registry-pull",
       "route": "DevOps", "digest": "sha256:<pulled digest>",
       "verifiedAt": "<ISO 8601 time>", "evidence": "<where the pull's nonsecret log is kept>"
     }
   }
   ```

`tests/deploy/aks-obs-01-overlay.test.ts` ("the overlay pins the loopcloser
image by the digest the publish workflow pushed") checks the record and the
overlay; it is reported as todo until the record exists, and a digest pinned
without it fails.
