import { CommandError, UserError } from "./git.ts";

/** Runs a script body: expected failures print their report and exit 1; anything else keeps its stack. */
export function runCli(body: () => void): void {
  try {
    body();
  } catch (error) {
    if (error instanceof UserError || error instanceof CommandError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

export function info(line: string): void {
  console.log(line);
}
