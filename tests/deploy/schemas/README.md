# Vendored validation schemas

JSON schemas that `tests/deploy/manifests.test.ts` hands to kubeconform as local
files, so manifest validation never fetches anything over the network.

- `kubernetes/v1.34.1-standalone-strict/`: from
  [yannh/kubernetes-json-schema](https://github.com/yannh/kubernetes-json-schema)
  at commit `2bfaff3898a7a4fa4e4760da3d2656211c9b4c71`, same paths.
- `crds/<group>/<kind>_<version>.json`: from
  [datreeio/CRDs-catalog](https://github.com/datreeio/CRDs-catalog) at commit
  `3e8a8916ca1b7af6464606c2c2f5869dbafa9653`, same paths.

The files are byte-for-byte copies, except one derived file (below);
`SHA256SUMS` records them all and the test checks it.

- `kubernetes/v1.34.1-standalone-strict/job-batch-v1.json` is **derived**, not
  copied: the upstream file could not be fetched when the aks-obs-01 schema Job
  was added (LC-EST-OVERLAY). It is the vendored `cronjob-batch-v1.json`'s
  `spec.jobTemplate` (the upstream ObjectMeta and JobSpec schemas, unchanged)
  as a top-level `batch/v1` `Job`, with no `status`.
  `tests/deploy/overlay.test.ts` re-derives it and requires an exact match.
  Replace it with the upstream copy from the commit above when one is at hand. They are standalone: no `$ref` leaves its own file, and `$schema`
names a JSON Schema draft that kubeconform has built in.

A manifest whose kind has no schema here fails validation. To add one, copy the
file from the same commit into the same path and regenerate the checksums:
`sha256sum $(find . -name '*.json' | sort | sed 's|^\./||') > SHA256SUMS`, run here.
