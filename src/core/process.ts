import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { SfciError, type Runtime } from "./types.js";

export function execute(
  file: string,
  args: string[],
  cwd: string,
  env = process.env,
): Promise<{ stdout: Buffer; stderr: Buffer; code: number }> {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) child.kill();
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.concat(err).length < 4 * 1024 * 1024) err.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      accept({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err),
        code: code ?? 1,
      }),
    );
  });
}
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute("git", args, cwd);
  if (result.code)
    throw new SfciError(
      `Git could not ${args[0] ?? "run"}.`,
      result.stderr.toString().trim().slice(0, 1000),
      "GIT",
    );
  return result.stdout.toString().trim();
}
export function privateSalesforceCli(): string {
  const require = createRequire(import.meta.url);
  const main = require.resolve("@salesforce/cli");
  return resolve(dirname(main), "..", "bin", "run.js");
}
export function salesforceEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    SF_AUTOUPDATE_DISABLE: "true",
    SF_DISABLE_TELEMETRY: "true",
    SF_USE_PROGRESS_BAR: "false",
    // Isolate oclif's user plugin inventory; auth still uses ~/.sf and ~/.sfdx.
    SF_DATA_DIR: resolve(homedir(), ".cache", "sfci", "salesforce-2.156.8"),
    NO_COLOR: "1",
  };
  delete environment.FORCE_COLOR;
  return environment;
}

export const defaultRuntime: Runtime = {
  async sf(args, cwd) {
    const result = await execute(
      process.execPath,
      [privateSalesforceCli(), ...args, "--json"],
      cwd,
      salesforceEnvironment(),
    );
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(result.stdout.toString()) as Record<
        string,
        unknown
      >;
    } catch {
      throw new SfciError(
        "Salesforce CLI returned an unreadable result.",
        "Run sfci doctor and inspect the Salesforce CLI installation.",
        "SALESFORCE",
      );
    }
    if (result.code !== 0 || envelope.status !== 0) {
      const body = envelope.result as Record<string, unknown> | undefined;
      // Failed reports contain the authoritative terminal state even when the CLI exits nonzero.
      if (
        args[0] === "project" &&
        args[1] === "deploy" &&
        args[2] === "report" &&
        body?.done === true
      )
        return body;
      const detail =
        typeof envelope.message === "string"
          ? envelope.message
          : typeof body?.status === "string"
            ? body.status
            : "Salesforce operation failed";
      throw new SfciError(
        detail,
        "Inspect Deployment Status in the target org before retrying a deployment.",
        "SALESFORCE",
      );
    }
    if (typeof envelope.result !== "object" || envelope.result === null)
      throw new SfciError(
        "Salesforce CLI returned no result.",
        undefined,
        "SALESFORCE",
      );
    return envelope.result as Record<string, unknown>;
  },
};
