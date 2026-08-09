import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExecResultLike } from "../types";

export async function runCommand(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  cwd: string = process.cwd(),
): Promise<ExecResultLike> {
  try {
    return await pi.exec(command, args, { cwd });
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      killed: false,
    };
  }
}

export function summarizeError(result: ExecResultLike): string {
  const details = (result.stderr || result.stdout).trim();
  return details || `Command failed with exit code ${result.code}`;
}
