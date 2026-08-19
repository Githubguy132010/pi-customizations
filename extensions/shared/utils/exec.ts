import type { ExecOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExecResultLike } from "../types";

export async function runCommand(
  pi: ExtensionAPI,
  command: string,
  args: string[],
  cwd: string = process.cwd(),
  options: Omit<ExecOptions, "cwd"> = {},
): Promise<ExecResultLike> {
  try {
    return await pi.exec(command, args, { ...options, cwd });
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
