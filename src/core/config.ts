import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { SfciError, type Config, type Environment } from "./types.js";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export async function readConfig(cwd: string): Promise<Config> {
  let value: unknown;
  try {
    value = parse(await readFile(resolve(cwd, "sfci.yml"), "utf8"));
  } catch {
    throw new SfciError(
      "Cannot read sfci.yml.",
      "Run sfci init or fix the YAML configuration.",
      "CONFIG",
    );
  }
  return parseConfig(value);
}
export function parseConfig(value: unknown): Config {
  if (
    !record(value) ||
    typeof value.trunk !== "string" ||
    !value.trunk.trim() ||
    !record(value.environments)
  ) {
    throw new SfciError(
      "sfci.yml needs a trunk and an environments mapping.",
      undefined,
      "CONFIG",
    );
  }
  const unknown = Object.keys(value).filter(
    (key) => !["trunk", "environments"].includes(key),
  );
  if (unknown.length)
    throw new SfciError(
      `Unknown configuration field: ${unknown.join(", ")}.`,
      undefined,
      "CONFIG",
    );
  const environments: Record<string, Environment> = {};
  for (const [name, env] of Object.entries(value.environments)) {
    if (
      !/^[a-z][a-z0-9-]{0,47}$/.test(name) ||
      !record(env) ||
      typeof env.org !== "string" ||
      !env.org.trim() ||
      env.org.startsWith("-") ||
      /[\s\u0000-\u001f\u007f]/.test(env.org)
    ) {
      throw new SfciError(
        `Invalid environment ${name}.`,
        "Use a lowercase name and a Salesforce org alias or username.",
        "CONFIG",
      );
    }
    if (
      Object.keys(env).some(
        (key) => !["org", "type", "tests", "promoteFrom"].includes(key),
      )
    ) {
      throw new SfciError(
        `Unknown configuration field in ${name}.`,
        undefined,
        "CONFIG",
      );
    }
    const tests = env.tests ?? "RunLocalTests";
    if (
      env.type !== undefined &&
      env.type !== "sandbox" &&
      env.type !== "production"
    )
      throw new SfciError(
        `Invalid org type for ${name}.`,
        "Choose sandbox or production.",
        "CONFIG",
      );
    if (tests !== "RunLocalTests" && tests !== "NoTestRun")
      throw new SfciError(
        `Invalid test level for ${name}.`,
        undefined,
        "CONFIG",
      );
    if (env.promoteFrom !== undefined && typeof env.promoteFrom !== "string")
      throw new SfciError(
        `Invalid promoteFrom for ${name}.`,
        undefined,
        "CONFIG",
      );
    environments[name] = {
      org: env.org,
      tests,
      ...(env.type ? { type: env.type as "sandbox" | "production" } : {}),
      ...(typeof env.promoteFrom === "string"
        ? { promoteFrom: env.promoteFrom }
        : {}),
    };
  }
  if (!Object.keys(environments).length)
    throw new SfciError(
      "Configure at least one environment.",
      undefined,
      "CONFIG",
    );
  for (const [name, env] of Object.entries(environments)) {
    if (
      env.promoteFrom &&
      (!environments[env.promoteFrom] || env.promoteFrom === name)
    ) {
      throw new SfciError(
        `Invalid promotion source for ${name}.`,
        undefined,
        "CONFIG",
      );
    }
    const seen = new Set([name]);
    let source = env.promoteFrom;
    while (source) {
      if (seen.has(source))
        throw new SfciError(
          "Promotion sources contain a cycle.",
          undefined,
          "CONFIG",
        );
      seen.add(source);
      source = environments[source]?.promoteFrom;
    }
  }
  return { trunk: value.trunk, environments };
}
