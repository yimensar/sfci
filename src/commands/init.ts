import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { CliError, interactive, type OutputOptions } from "../ui.js";
import { parseConfig } from "../core/config.js";
import type { Environment } from "../core/types.js";
import { bitbucketPipeline, githubWorkflow } from "./templates.js";

const exec = promisify(execFile);
interface InitOptions {
  cwd: string;
  ci?: string;
  environments?: string[];
  promotions?: string[];
  trunk?: string;
}

export async function initialize(
  options: InitOptions,
  output: OutputOptions,
): Promise<{ files: string[]; notes: string[] }> {
  const cwd = resolve(options.cwd);
  await requireProject(cwd);
  if (await exists(resolve(cwd, "sfci.yml")))
    throw new CliError(
      "sfci.yml already exists.",
      "Edit the existing configuration; init never overwrites it.",
    );
  let { ci } = options;
  let trunk = options.trunk ?? "main";
  const environments: Record<string, Environment> = {};
  for (const spec of options.environments ?? []) {
    const [name, type, org, ...extra] = spec.split(":");
    if (
      !name ||
      !["sandbox", "production"].includes(type ?? "") ||
      extra.length ||
      environments[name]
    )
      throw new CliError(
        "Invalid or duplicate environment definition.",
        "Use --environment name:sandbox[:alias] or name:production[:alias].",
      );
    environments[name] = {
      type: type as "sandbox" | "production",
      org: org || name,
      tests: "RunLocalTests",
    };
  }
  if ((!ci || !Object.keys(environments).length) && !interactive(output))
    throw new CliError(
      "Setup needs a CI provider and at least one named environment.",
      "Run sfci init --ci bitbucket --environment preprod:sandbox:my-preprod --environment prod:production:my-prod --promote preprod:prod.",
    );
  if (interactive(output) && (!ci || !Object.keys(environments).length)) {
    const prompts = await import("@clack/prompts");
    const answer = async <T>(
      value: Promise<T>,
    ): Promise<Exclude<T, symbol>> => {
      const result = await value;
      if (prompts.isCancel(result))
        throw new CliError("Cancelled.", undefined, "CANCELLED");
      return result as Exclude<T, symbol>;
    };
    prompts.intro("sfci · Salesforce delivery", { output: process.stderr });
    ci ??= await answer(
      prompts.select({
        message: "Where will the pipeline run?",
        options: [
          { value: "bitbucket", label: "Bitbucket Pipelines" },
          { value: "github", label: "GitHub Actions" },
        ],
        output: process.stderr,
      }),
    );
    if (!options.trunk)
      trunk = await answer(
        prompts.text({
          message: "Trunk branch",
          defaultValue: "main",
          output: process.stderr,
        }),
      );
    if (!Object.keys(environments).length) {
      let another = true;
      while (another) {
        const name = await answer(
          prompts.text({
            message: "Environment name",
            placeholder: "integration, preprod, prod…",
            validate: (value) =>
              /^[a-z][a-z0-9-]{0,47}$/.test(value ?? "") &&
              !environments[value!]
                ? undefined
                : "Use a unique lowercase name.",
            output: process.stderr,
          }),
        );
        const type = await answer(
          prompts.select({
            message: `Org type for ${name}`,
            options: [
              { value: "sandbox" as const, label: "Sandbox" },
              { value: "production" as const, label: "Production" },
            ],
            output: process.stderr,
          }),
        );
        const org = await answer(
          prompts.text({
            message: `Existing Salesforce alias or username for ${name}`,
            defaultValue: name,
            validate: validateAlias,
            output: process.stderr,
          }),
        );
        const source = await answer(
          prompts.select({
            message: `Where does ${name} receive releases from?`,
            options: [
              {
                value: "",
                label: type === "production"
                  ? "Current trunk (manually started deployment)"
                  : "Current trunk (automatic deployment)",
              },
              ...Object.keys(environments).map((value) => ({
                value,
                label: value,
              })),
            ],
            output: process.stderr,
          }),
        );
        environments[name] = {
          org,
          type,
          tests: "RunLocalTests",
          ...(source ? { promoteFrom: source } : {}),
        };
        another = await answer(
          prompts.confirm({
            message: "Add another environment?",
            initialValue: true,
            output: process.stderr,
          }),
        );
      }
    }
  }
  if (ci !== "github" && ci !== "bitbucket")
    throw new CliError(
      "Unknown CI provider.",
      "Choose --ci github or --ci bitbucket.",
    );
  for (const spec of options.promotions ?? []) {
    const [source, target, ...extra] = spec.split(":");
    if (
      !source ||
      !target ||
      extra.length ||
      !environments[target] ||
      environments[target]!.promoteFrom
    )
      throw new CliError(
        "Invalid or duplicate promotion.",
        "Use --promote source:target with declared environments.",
      );
    environments[target]!.promoteFrom = source;
  }
  if (
    new Set(Object.values(environments).map((env) => env.org)).size !==
    Object.keys(environments).length
  )
    throw new CliError("Use a distinct org alias for each environment.");
  const parsed = parseConfig({ trunk, environments });
  try {
    await exec("git", ["check-ref-format", "--branch", trunk], { cwd });
  } catch {
    throw new CliError(
      "Invalid trunk branch.",
      "Choose a valid Git branch name with --trunk.",
    );
  }

  const { stringify } = await import("yaml");
  const config = stringify(parsed);
  const normalPath =
    ci === "github" ? ".github/workflows/sfci.yml" : "bitbucket-pipelines.yml";
  const notes: string[] = [];
  let pipelinePath = normalPath;
  if (await exists(resolve(cwd, normalPath))) {
    pipelinePath =
      ci === "github"
        ? "sfci.github.example.yml"
        : "sfci.bitbucket.example.yml";
    notes.push(
      `Existing pipeline kept. Merge ${pipelinePath} into it when ready.`,
    );
  }
  if (await exists(resolve(cwd, pipelinePath)))
    throw new CliError(
      `${pipelinePath} already exists.`,
      "Move or review the existing example before initializing.",
    );
  const gitignore = resolve(cwd, ".gitignore");
  const existingIgnore = await readIgnore(gitignore);
  const additions = [
    { path: "sfci.yml", content: config },
    {
      path: pipelinePath,
      content:
        ci === "github" ? githubWorkflow(parsed) : bitbucketPipeline(parsed),
    },
  ];
  const files: string[] = [];
  try {
    for (const addition of additions) {
      await mkdir(dirname(resolve(cwd, addition.path)), { recursive: true });
      await writeFile(resolve(cwd, addition.path), addition.content, {
        flag: "wx",
      });
      files.push(addition.path);
    }
    if (
      !existingIgnore
        .split(/\r?\n/)
        .some((line) => /^\/?\.sfci\/?$/.test(line.trim()))
    ) {
      const temporaryIgnore = `${gitignore}.sfci-${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporaryIgnore,
          `${existingIgnore}${existingIgnore && !existingIgnore.endsWith("\n") ? "\n" : ""}.sfci/\n`,
          { flag: "wx" },
        );
        await rename(temporaryIgnore, gitignore);
      } finally {
        await rm(temporaryIgnore, { force: true });
      }
      notes.push("Added .sfci/ to .gitignore.");
    }
  } catch (error) {
    for (const path of files) await rm(resolve(cwd, path), { force: true });
    throw error;
  }
  notes.push(
    "Set SF_CLIENT_ID, SF_USERNAME, SF_INSTANCE_URL and secured SF_JWT_KEY_B64 for each CI environment. No credentials were written.",
  );
  notes.push(
    "Commit these files, then record the verified baseline of each org.",
  );
  return { files, notes };
}

export async function generatePipeline(options: {
  cwd: string;
  ci: "bitbucket" | "github";
}): Promise<{ files: string[]; notes: string[] }> {
  const cwd = resolve(options.cwd);
  await requireProject(cwd);
  const config = await (await import("../core/config.js")).readConfig(cwd);
  const normal =
    options.ci === "bitbucket"
      ? "bitbucket-pipelines.yml"
      : ".github/workflows/sfci.yml";
  const path = (await exists(resolve(cwd, normal)))
    ? `sfci.${options.ci}.example.yml`
    : normal;
  await mkdir(dirname(resolve(cwd, path)), { recursive: true });
  await writeFile(
    resolve(cwd, path),
    options.ci === "bitbucket"
      ? bitbucketPipeline(config)
      : githubWorkflow(config),
    { flag: "wx" },
  );
  return {
    files: [path],
    notes: ["Generated from sfci.yml. Review the pipeline before committing."],
  };
}

function validateAlias(value: string | undefined): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9_.@+-]{0,127}$/.test(value ?? "")
    ? undefined
    : "Use a simple org alias or Salesforce username (letters, digits, ., _, @, +, -).";
}

async function requireProject(cwd: string): Promise<void> {
  let root: string;
  try {
    root = (
      await exec("git", ["rev-parse", "--show-toplevel"], { cwd })
    ).stdout.trim();
  } catch {
    throw new CliError(
      "No Git repository found.",
      "Run sfci init from the root of a Salesforce DX repository.",
    );
  }
  if ((await realpath(root)) !== (await realpath(cwd)))
    throw new CliError(
      "Run init from the repository root.",
      `Project root: ${root}`,
    );
  let project: unknown;
  try {
    project = JSON.parse(
      await readFile(resolve(cwd, "sfdx-project.json"), "utf8"),
    );
  } catch {
    throw new CliError(
      "Cannot read sfdx-project.json.",
      "Run init from a valid Salesforce DX project.",
    );
  }
  if (
    typeof project !== "object" ||
    project === null ||
    !Array.isArray((project as Record<string, unknown>).packageDirectories) ||
    !(project as { packageDirectories: unknown[] }).packageDirectories.length
  ) {
    throw new CliError(
      "sfdx-project.json has no package directories.",
      "Configure the Salesforce source folders first.",
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function readIgnore(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (!info.isFile())
      throw new CliError(
        ".gitignore must be a regular file.",
        "Review it before letting init add the .sfci/ exclusion.",
      );
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
