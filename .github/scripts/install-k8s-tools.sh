#!/usr/bin/env bash
# Installs the pinned, checksum-verified kubectl, kustomize and kubeconform that
# tests/deploy/manifests.test.ts uses, into $RUNNER_TEMP/k8s-tools, and exports
# KUBECTL, KUSTOMIZE and KUBECONFORM through $GITHUB_ENV. Versions come from the
# calling job's env. Never configures a cluster or reads a secret.
set -euo pipefail
: "${KUBECTL_VERSION:?}" "${KUSTOMIZE_VERSION:?}" "${KUBECONFORM_VERSION:?}"
bin="$RUNNER_TEMP/k8s-tools"
mkdir -p "$bin"
cd "$bin"

curl -fsSLo kubectl "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
echo "$(curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl.sha256")  kubectl" | sha256sum --check --strict
chmod +x kubectl

tarball="kustomize_${KUSTOMIZE_VERSION}_linux_amd64.tar.gz"
base="https://github.com/kubernetes-sigs/kustomize/releases/download/kustomize%2F${KUSTOMIZE_VERSION}"
curl -fsSLo "$tarball" "$base/$tarball"
curl -fsSL "$base/checksums.txt" | grep " ${tarball}\$" | sha256sum --check --strict
tar -xzf "$tarball" kustomize
rm "$tarball"

tarball="kubeconform-linux-amd64.tar.gz"
base="https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}"
curl -fsSLo "$tarball" "$base/$tarball"
curl -fsSL "$base/CHECKSUMS" | grep "  ${tarball}\$" | sha256sum --check --strict
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
