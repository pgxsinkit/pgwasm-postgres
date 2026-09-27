/**
 * podman, and only podman: the builder image and the build run in it, locally and (later) in CI. Every
 * container this repository starts is named `pgwasm-postgres-*`, so a leftover one is found by name.
 */
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
