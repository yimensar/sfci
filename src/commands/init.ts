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
import { bitbucketPipeline, githubWorkflow } from "./templates.js";

const exec = promisify(execFile);
interface InitOptions {
  cwd: string;
  ci?: string;
  uat?: string;
  production?: string;
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
  let { ci, uat, production } = options;
  let trunk = options.trunk ?? "main";
  if ((!ci || !uat || !production) && !interactive(output)) {
    throw new CliError(
      "Setup needs a CI provider and two org aliases.",
      "Run sfci init --ci github --uat <alias> --production <alias>, or use an interactive terminal.",
    );
  }
  if (interactive(output) && (!ci || !uat || !production)) {
    const prompts = await import("@clack/prompts");
    const answer = async (value: Promise<string | symbol>): Promise<string> => {
      const result = await value;
      if (prompts.isCancel(result))
        throw new CliError("Cancelled.", undefined, "CANCELLED");
      return result as string;
    };
    prompts.intro("sfci · Salesforce delivery", { output: process.stderr });
    ci ??= await answer(
      prompts.select({
        message: "Where will the pipeline run?",
        options: [
          { value: "github", label: "GitHub Actions" },
          { value: "bitbucket", label: "Bitbucket Pipelines" },
        ],
        output: process.stderr,
      }),
    );
    if (!options.trunk)
      trunk = await answer(
        prompts.text({
          message: "Trunk branch",
          defaultValue: "main",
          placeholder: "main",
          output: process.stderr,
        }),
      );
    uat ??= await answer(
      prompts.text({
        message: "UAT org alias or username",
        placeholder: "uat",
        validate: validateAlias,
        output: process.stderr,
      }),
    );
    production ??= await answer(
      prompts.text({
        message: "Production org alias or username",
        placeholder: "production",
        validate: validateAlias,
        output: process.stderr,
      }),
    );
  }
  if (ci !== "github" && ci !== "bitbucket")
    throw new CliError(
      "Unknown CI provider.",
      "Choose --ci github or --ci bitbucket.",
    );
  if (!uat || !production) throw new CliError("Both org aliases are required.");
  for (const alias of [uat, production]) {
    const message = validateAlias(alias);
    if (message) throw new CliError(message);
  }
  if (uat === production)
    throw new CliError(
      "UAT and production must use different aliases.",
      "Use a distinct Salesforce org for each environment.",
    );
  try {
    await exec("git", ["check-ref-format", "--branch", trunk], { cwd });
  } catch {
    throw new CliError(
      "Invalid trunk branch.",
      "Choose a valid Git branch name with --trunk.",
    );
  }

  const { stringify } = await import("yaml");
  const config = stringify({
    trunk,
    environments: {
      uat: { org: uat, tests: "RunLocalTests" },
      production: {
        org: production,
        tests: "RunLocalTests",
        promoteFrom: "uat",
      },
    },
  });
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
        ci === "github"
          ? githubWorkflow({ trunk, uat, production })
          : bitbucketPipeline({ trunk, uat, production }),
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
    "Set a protected SF_AUTH_URL secret for each CI environment; no credentials were written.",
  );
  notes.push(
    "Commit these files, then record the verified baseline of each org.",
  );
  return { files, notes };
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
