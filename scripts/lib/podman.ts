/**
 * podman, and only podman: the builder image and the build run in it, locally and in CI. Every container this
 * repository starts is named `pgwasm-postgres-*`, so a leftover one is found by name.
 */
import { rmSync } from "node:fs";

import { CommandError, UserError, type RunResult } from "./git.ts";

/** The name prefix of every container this repository starts. */
export const CONTAINER_PREFIX = "pgwasm-postgres-";

export interface PodmanOptions {
  /** Return a failing result instead of throwing. */
  readonly allowFailure?: boolean;
}

export function podman(args: readonly string[], options: PodmanOptions = {}): RunResult {
  const command = ["podman", ...args];
  const proc = Bun.spawnSync(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const result: RunResult = {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
  if (result.exitCode !== 0 && options.allowFailure !== true) {
    throw new CommandError(command, process.cwd(), result);
  }
  return result;
}

/** Refuses to go on without podman on the PATH. */
export function requirePodman(): void {
  if (Bun.which("podman") === null) {
    throw new UserError(
      "podman is not installed (or not on the PATH). The builder image and the build run in podman; install it first.",
    );
  }
}

/** The local image's id, or `undefined` when there is no image by that name. */
export function imageId(image: string): string | undefined {
  const inspect = podman(["image", "inspect", "--format", "{{.Id}}", image], { allowFailure: true });
  const id = inspect.stdout.trim();
  return inspect.exitCode === 0 && /^[0-9a-f]{64}$/.test(id) ? id : undefined;
}

/** The registry digests podman knows for a local image (`<repository>@sha256:…`: pulled or pushed). */
export function repoDigests(image: string): string[] {
  const inspect = podman(["image", "inspect", "--format", "{{json .RepoDigests}}", image], { allowFailure: true });
  if (inspect.exitCode !== 0) return [];
  const parsed: unknown = JSON.parse(inspect.stdout.trim() || "[]");
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * The resource caps podman can apply here. Rootless podman limits CPU and memory only through the cgroup
 * controllers delegated to the user (`podman info`'s CgroupControllers): a desktop session has `cpu` and
 * `memory`, a CI runner's service user may have neither, and podman then refuses a container that asks for them.
 * The caps protect a small host and change no compiler input, so a cap podman cannot apply is left out.
 */
export interface ResourceCaps {
  readonly cpu: boolean;
  readonly memory: boolean;
}

export const ALL_CAPS: ResourceCaps = { cpu: true, memory: true };

export function capsOf(controllers: readonly string[]): ResourceCaps {
  return { cpu: controllers.includes("cpu"), memory: controllers.includes("memory") };
}

export function resourceCaps(log: (line: string) => void): ResourceCaps {
  const info = podman(["info", "--format", "{{json .Host.CgroupControllers}}"], { allowFailure: true });
  let controllers: string[] = [];
  if (info.exitCode === 0) {
    const parsed: unknown = JSON.parse(info.stdout.trim() || "[]");
    if (Array.isArray(parsed)) controllers = parsed.filter((entry): entry is string => typeof entry === "string");
  }
  const caps = capsOf(controllers);
  const missing = (Object.keys(caps) as (keyof ResourceCaps)[]).filter((key) => !caps[key]);
  if (missing.length > 0) {
    log(
      `podman: the ${missing.join(" and ")} cgroup controller${missing.length > 1 ? "s are" : " is"} not delegated here (${controllers.join(" ") || "none"}); running without that cap.`,
    );
  }
  return caps;
}

/** Pulls an image by reference (a digest reference, for the published builder); fails with podman's message. */
export function pullImage(reference: string): void {
  const result = podman(["pull", "--quiet", reference], { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new UserError(
      [
        `podman pull ${reference} failed (exit ${result.exitCode}):`,
        ...result.stderr
          .trim()
          .split("\n")
          .map((line) => `  ${line}`),
      ].join("\n"),
    );
  }
}

/** Every container of this repository, running or not. */
export function ourContainers(): string[] {
  return podman(["ps", "--all", "--filter", `name=^${CONTAINER_PREFIX}`, "--format", "{{.Names}}\t{{.Status}}"])
    .stdout.split("\n")
    .filter((line) => line.trim() !== "");
}

/** Refuses to start while another container of this repository exists: a build in progress, or a leftover. */
export function refuseOtherContainers(): void {
  const containers = ourContainers();
  if (containers.length === 0) return;
  const names = containers.map((line) => line.split("\t")[0] ?? line);
  throw new UserError(
    [
      "Another pgwasm-postgres container exists:",
      ...containers.map((line) => `  ${line.replace("\t", "  ")}`),
      "Wait for that build to finish. If it is a leftover (no build of this repository is running), remove it with",
      `  podman rm --force ${names.join(" ")}`,
    ].join("\n"),
  );
}

/** Stops and removes a container if it exists; never fails. */
export function removeContainer(name: string): void {
  podman(["rm", "--force", "--ignore", "--time", "5", name], { allowFailure: true });
}

/**
 * Deletes a directory a container wrote into. Rootless podman maps the container's root to the calling user, so
 * a plain delete normally works; anything the build wrote as another in-container user belongs to a subordinate
 * uid, which only `podman unshare` can delete.
 */
export function removeBuildOutput(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    podman(["unshare", "rm", "-rf", "--", path]);
  }
}
