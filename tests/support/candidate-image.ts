// The candidate image tests/deploy/deploy-candidate.test.ts deploys, made from
// local inputs only (LC-DEPLOY-CANDIDATE-DB-ROLE).
//
// `docker build` resolves a FROM reference through its builder, which may ask
// the registry for it even when the daemon already holds the image. So the
// image is never built: the base reference is resolved once, in the daemon, to
// its local image ID (sha256:...), and every later command names that ID. A
// container is created from it, the context is copied in, and the container is
// committed with Dockerfile-style changes. An image ID is never pulled, so
// nothing here can reach a registry.
//
// A command that only reads (the base's inspect) is given the caller's signal
// and killed once it aborts. A command that changes what the daemon holds
// (create, cp, commit, rm) is not: it runs until the daemon has completed it,
// bounded only by the docker the caller gives, so the caller's teardown, run
// once this has settled, finds and removes everything it made. Between commands
// the signal is checked, and no further command starts once it has aborted.
//
// Public functions: localImageId, commitImage.
import type { Docker } from "../../.github/scripts/deploy-candidate.mjs";

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** The local image ID of `ref`, which the daemon must already hold; rejects naming `ref` if it does not. */
export async function localImageId(docker: Docker, ref: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  let id: string;
  try {
    id = (await docker(["image", "inspect", "--format", "{{.Id}}", ref], signal ? { signal } : {})).trim();
  } catch (err) {
    throw new Error(`${ref} is not in this Docker daemon: ${(err as Error).message}`);
  }
  if (!IMAGE_ID.test(id)) throw new Error(`${ref} has no local image ID: ${JSON.stringify(id)}`);
  return id;
}

export interface CommitImageInput {
  docker: Docker;
  /** The image to start from, as a local image ID (localImageId), never a reference a builder could resolve. */
  fromId: string;
  /** A directory whose contents are copied into `into` in the image. */
  context: string;
  into: string;
  /** Dockerfile instructions applied to the image's config (ENV, WORKDIR, USER, EXPOSE, CMD). */
  changes?: string[];
  tag: string;
  /** The name of the container the image is committed from; it is removed whatever happens. */
  container: string;
  signal?: AbortSignal;
}

/** Commits `context` copied into `into` on `fromId` as `tag`, and resolves with the new image's local ID. */
export async function commitImage(input: CommitImageInput): Promise<string> {
  const { docker, fromId, context, into, changes = [], tag, container, signal } = input;
  if (!IMAGE_ID.test(fromId)) throw new Error(`${fromId} is not a local image ID`);
  signal?.throwIfAborted();
  try {
    await docker(["create", "--name", container, fromId]);
    signal?.throwIfAborted();
    await docker(["cp", `${context}/.`, `${container}:${into}`]);
    signal?.throwIfAborted();
    await docker(["commit", ...changes.flatMap((c) => ["--change", c]), container, tag]);
  } finally {
    await docker(["rm", "--force", container], { check: false });
  }
  return localImageId(docker, tag, signal);
}
