import { CommandError, UserError } from "./git.ts";

function reportExpected(error: unknown): void {
  if (error instanceof UserError || error instanceof CommandError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}

/** Runs a script body: expected failures print their report and exit 1; anything else keeps its stack. */
export function runCli(body: () => void): void {
  try {
    body();
  } catch (error) {
    reportExpected(error);
  }
}

/** `runCli` for a body that waits on something (a container, a child process). */
export async function runCliAsync(body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (error) {
    reportExpected(error);
  }
}

export function info(line: string): void {
  console.log(line);
}
