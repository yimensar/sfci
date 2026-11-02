import { constants } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createPrivateKey } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readConfig } from "../core/config.js";
import { runtime } from "../core/salesforce.js";
import { SfciError, type TargetOptions } from "../core/types.js";
import { CliError } from "../ui.js";

export interface AuthOptions extends TargetOptions {
  clientId?: string;
  username?: string;
  jwtKeyFile?: string;
  instanceUrl?: string;
}

export async function authenticate(
  options: AuthOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ target: string; org: string; method: "jwt"; keyFile: string }> {
  const config = await readConfig(options.cwd);
  const target = config.environments[options.target];
  if (!target)
    throw new CliError(
      `Unknown environment ${options.target}.`,
      "Choose an environment from sfci.yml.",
    );
  const clientId = required(
    options.clientId ?? environment.SF_CLIENT_ID ?? environment.SFDX_CLIENT_ID,
    "SF_CLIENT_ID",
  );
  const username = required(
    options.username ?? environment.SF_USERNAME,
    "SF_USERNAME",
  );
  const instanceUrl = required(
    options.instanceUrl ?? environment.SF_INSTANCE_URL,
    "SF_INSTANCE_URL",
  );
  validateInstanceUrl(instanceUrl);
  const providedFile = options.jwtKeyFile ?? environment.SF_JWT_KEY_FILE;
  const key = providedFile
    ? null
    : decodePrivateKey(
        required(
          environment.SF_JWT_KEY_B64,
          "SF_JWT_KEY_B64 or --jwt-key-file",
        ),
      );
  const directory = key ? await mkdtemp(resolve(tmpdir(), "sfci-jwt-")) : null;
  let authenticated = false;
  try {
    const path = providedFile
      ? resolve(options.cwd, providedFile)
      : resolve(directory!, "server.key");
    if (key) await writeFile(path, key, { mode: 0o600, flag: "wx" });
    else {
      try {
        await access(path, constants.R_OK);
      } catch {
        throw new CliError(
          "Cannot read the JWT private key file.",
          "Provide a readable --jwt-key-file or SF_JWT_KEY_FILE.",
          "AUTH_CONFIG",
        );
      }
    }
    try {
      await runtime(options).sf(
        [
          "org",
          "login",
          "jwt",
          `--client-id=${clientId}`,
          `--username=${username}`,
          `--instance-url=${instanceUrl}`,
          `--jwt-key-file=${path}`,
          `--alias=${target.org}`,
        ],
        options.cwd,
      );
    } catch (error) {
      if (error instanceof SfciError)
        throw new CliError(
          error.message,
          "Verify the JWT client ID, username, instance URL, certificate and the user's application authorization.",
          "AUTH_FAILED",
        );
      throw error;
    }
    // Salesforce stores this path and rereads the key to renew expired sessions.
    // Keep successful CI-session keys until the ephemeral runner is destroyed.
    authenticated = true;
    // Salesforce's response includes an access token. Never return or print it.
    return { target: options.target, org: target.org, method: "jwt", keyFile: path };
  } finally {
    if (directory && !authenticated)
      await rm(directory, { recursive: true, force: true });
  }
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim())
    throw new CliError(
      `JWT authentication requires ${name}.`,
      "Set the JWT variables for this CI environment, or supply the corresponding command options.",
      "AUTH_CONFIG",
    );
  return value.trim();
}

function decodePrivateKey(value: string): Buffer {
  const encoded = value.replace(/\s/g, "");
  try {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        encoded,
      )
    )
      throw new Error();
    const key = Buffer.from(encoded, "base64");
    if (createPrivateKey(key).asymmetricKeyType !== "rsa") throw new Error();
    return key;
  } catch {
    throw new CliError(
      "SF_JWT_KEY_B64 must contain a base64-encoded RSA private key.",
      "Encode the PEM key as base64. Store it as a secured CI variable; never commit it.",
      "AUTH_CONFIG",
    );
  }
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
