import { spawn } from "node:child_process";
import { readConfig } from "../core/config.js";
import {
  privateSalesforceCli,
  salesforceEnvironment,
} from "../core/process.js";
import { CliError, interactive, type OutputOptions } from "../ui.js";

export async function authenticate(
  options: { cwd: string; target: string; instanceUrl?: string },
  output: OutputOptions,
): Promise<number> {
  if (output.json)
    throw new CliError(
      "Web authentication does not support --json.",
      "Run sfci auth --target <environment> in an interactive terminal.",
    );
  if (!interactive(output))
    throw new CliError(
      "Web authentication needs an interactive terminal.",
      "For CI, use the bundled sf command with your protected authentication variables.",
    );
  const config = await readConfig(options.cwd);
  const environment = config.environments[options.target];
  if (!environment)
    throw new CliError(
      `Unknown environment ${options.target}.`,
      "Choose an environment from sfci.yml.",
    );
  if (options.instanceUrl) validateInstanceUrl(options.instanceUrl);
  const args = [
    privateSalesforceCli(),
    "org",
    "login",
    "web",
    `--alias=${environment.org}`,
    ...(options.instanceUrl ? [`--instance-url=${options.instanceUrl}`] : []),
  ];
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      stdio: "inherit",
      env: salesforceEnvironment(),
    });
    child.on("error", () =>
      reject(
        new CliError(
          "Cannot start the bundled Salesforce CLI.",
          "Reinstall sfci and run sfci doctor.",
        ),
      ),
    );
    child.on("close", (code, signal) =>
      accept(signal === "SIGINT" ? 130 : (code ?? 1)),
    );
  });
}

export function validateInstanceUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(
      "Invalid Salesforce instance URL.",
      "Use an HTTPS Salesforce login or My Domain URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new CliError(
      "Invalid Salesforce instance URL.",
      "Use an HTTPS URL without credentials, query parameters, or a path.",
    );
  }
}
