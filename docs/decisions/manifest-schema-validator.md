# Decision record: schema validator for the deployment manifests

Date: 2026-11-15 · Task: LC-M3-MANIFEST-CHECK-b · Status: adopted (task default)

## Context

The pull-request manifest check (`tests/deploy/manifests.test.ts`, CI job
`manifests`) renders every kustomize overlay and runs it through
`kubectl annotate --local --dry-run=client`. That decodes each document as an
unstructured object and never checks it against a schema, so a Deployment with
`spec.replicas: "invalid"` passed (review of LC-M3-MANIFEST-CHECK, PR #18).

The check has to reject, with no cluster, kubeconfig, secret or network access:

1. a field of the wrong type (a string `spec.replicas` on a Deployment);
2. a field the resource schema does not define (`spec.replica`, strict mode);

and has to pass the repository's own rendered manifests.

## Options compared

| | kubeconform, schemas vendored | kubectl `--dry-run=server` against a kind cluster |
|---|---|---|
| Catches (1) wrong type | Yes: JSON-schema type check | Yes: API server decoding |
| Catches (2) unknown field | Yes, with `-strict` | Yes, with `--validate=strict` (field validation) |
| Needs a cluster | No | Yes: a kind cluster per CI run (Docker, node image pull) |
| Needs a kubeconfig | No | Yes, the kind cluster's |
| Network in the check | None: schemas are local files (`tests/deploy/schemas/`, `SHA256SUMS`) | Node image pull at cluster creation, unless pre-cached |
| CRD kinds (CNPG `Cluster`, `ExternalSecret`) | Vendored CRD schemas | The CRDs must be installed into the kind cluster first |
| Runs on a developer machine | One static binary | Docker plus kind; minutes per run |
| CI time | Seconds | ~1–2 min cluster start-up per run |
| Version pinning | Binary checksum-verified; schemas pinned to upstream commits and checksummed in repo | kind and node image pinned by digest; API server version is the node image's |
| Fidelity | Schema only: no admission webhooks, no defaulting, no cross-object checks | Real API server: schema plus built-in validation (e.g. immutable fields, some value rules) |

Other candidates looked at and not preferred: `kubeval` (unmaintained,
superseded by kubeconform); `kubectl apply --validate=strict --dry-run=client`
(still needs a server's OpenAPI document to validate, so not offline).

## Decision

kubeconform, pinned (`KUBECONFORM_VERSION` in `.github/workflows/ci.yml`) and
checksum-verified at install (`.github/scripts/install-k8s-tools.sh`), run with
`-strict` against schemas vendored under `tests/deploy/schemas/` and given to it
as local paths only. The test runs it in an environment with no kubeconfig, no
in-cluster variables and every HTTP(S) request routed to a dead proxy, so a
fetch would fail loudly rather than pass.

Both must-catch cases are caught without a cluster, which is the constraint
that rules out the kind option as the default: it needs a cluster, a
kubeconfig and an image pull for a check that a schema answers. The kind
server dry-run's extra fidelity (server-side value rules, defaulting) is
outside this task's case list.

## Consequences

- A kind with no vendored schema fails the check; adding one means copying
  its schema from the pinned upstream commit and regenerating `SHA256SUMS`
  (`tests/deploy/schemas/README.md`).
- Errors only an API server reports (immutable-field changes, admission
  webhooks) are not caught here. A counterexample of that kind is new work.
- Open gap (recorded, not changed here): the kubeconform tarball's checksum is
  taken from the release's own `CHECKSUMS` file at install time rather than a
  digest committed in this repository.
