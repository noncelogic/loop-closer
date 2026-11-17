#!/usr/bin/env bash
# Installs the pinned, checksum-verified kubectl, kustomize and kubeconform that
# tests/deploy/manifests.test.ts uses, into $RUNNER_TEMP/k8s-tools, and exports
# KUBECTL, KUSTOMIZE and KUBECONFORM through $GITHUB_ENV. Versions come from the
# calling job's env. Never configures a cluster or reads a secret.
#
# Every download goes through `fetch`, which retries transient upstream errors
# (connection failures, timeouts, HTTP 408/429/5xx) a bounded number of times
# and still fails on a persistent one: a single 502 from the release CDN must
# not fail CI (ci run 43992607415). Checksums are verified as before.
# Sourcing this file defines `fetch` without installing anything
# (tests/deploy/install-k8s-tools.test.ts).

fetch() {
  curl -fsSL --retry 5 --retry-connrefused --retry-delay "${INSTALL_K8S_TOOLS_RETRY_DELAY:-3}" --retry-max-time 120 "$@"
}

install_k8s_tools() {
  set -euo pipefail
  : "${KUBECTL_VERSION:?}" "${KUSTOMIZE_VERSION:?}" "${KUBECONFORM_VERSION:?}"
  local bin="$RUNNER_TEMP/k8s-tools"
  mkdir -p "$bin"
  cd "$bin"

  fetch -o kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
  echo "$(fetch "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256")  kubectl" | sha256sum --check --strict
  chmod +x kubectl

  local tarball base
  tarball="kustomize_${KUSTOMIZE_VERSION}_linux_amd64.tar.gz"
  base="https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F${KUSTOMIZE_VERSION}"
  fetch -o "$tarball" "$base/$tarball"
  fetch "$base/checksums.txt" | grep " ${tarball}\$" | sha256sum --check --strict
  tar -xzf "$tarball" kustomize
  rm "$tarball"

  tarball="kubeconform-linux-amd64.tar.gz"
  base="https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}"
  fetch -o "$tarball" "$base/$tarball"
  fetch "$base/CHECKSUMS" | grep "  ${tarball}\$" | sha256sum --check --strict
  tar -xzf "$tarball" kubeconform
  rm "$tarball"

  {
    echo "KUBECTL=$bin/kubectl"
    echo "KUSTOMIZE=$bin/kustomize"
    echo "KUBECONFORM=$bin/kubeconform"
  } >> "$GITHUB_ENV"
  ./kubectl version --client
  ./kustomize version
  ./kubeconform -v
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  install_k8s_tools
fi
