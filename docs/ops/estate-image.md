# Estate image publish

`.github/workflows/estate-image.yml` runs on every merge to `main`. It builds
the loopcloser image on a GitHub-hosted runner (`ubuntu-latest`, as `ci` does)
and pushes it to the estate registry that aks-obs-01 pulls from as
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

The registry push credential is per product (policy
`registry-credential-per-product`). The job reads it from the repository
secrets below; only pushes to `main` can reach them.

This page lists configuration **by name only**. Values live in the repository
variables and secrets below; credentials never go in this repository.
`tests/deploy/image-workflow.test.ts` checks that this page names exactly what
the workflow reads.

## Repository variables

Set under *Settings → Secrets and variables → Actions → Variables* on
`noncelogic/loop-closer`. These are configuration, not secrets. The job's first
step fails with `repository variable <NAME> is not set` if any of them is
empty.

| Variable | Read by | Holds |
| --- | --- | --- |
| `ESTATE_REGISTRY` | `docker/login-action`, `docker/build-push-action` | Registry host aks-obs-01 pulls from; the image is pushed as `<ESTATE_REGISTRY>/loopcloser:sha-<commit>` |

## Repository secrets

Set under *Settings → Secrets and variables → Actions → Secrets* on
`noncelogic/loop-closer`. The job's first step fails with
`repository secret <NAME> is not set` if any of them is empty. They reach only
`docker/login-action`.

| Secret | Read by | Holds |
| --- | --- | --- |
| `ESTATE_REGISTRY_USERNAME` | `docker/login-action` (`username`) | Registry push username |
| `ESTATE_REGISTRY_PASSWORD` | `docker/login-action` (`password`) | Registry push password/token |

## Pull-request dry run

The publish acts only on `main`, so every pull request proves it first: the
`ci` workflow's `estate-image-dry-run` job builds the same context and
Dockerfile on a GitHub-hosted runner, tags it `loopcloser:sha-<commit>`
without a registry, pushes nothing, and runs the listings-read CronJob's
command (`node dist/portal-read.js`) in the built image through
`.github/scripts/estate-image-smoke.sh`. It reads no secret and no repository
variable. `test/deploy/estate-image.test.ts` checks the job and runs the same
build and smoke check.

## Verifying a publish

1. Merge to `main`, then check that the `estate-image` run's `publish` job
   passes (`gh run list --workflow estate-image`).
2. If *Check estate registry configuration* fails, one of the variables or
   secrets above is unset.
3. If the registry login or push fails, the secrets do not hold a credential
   that can push `loopcloser` to `ESTATE_REGISTRY`.
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
