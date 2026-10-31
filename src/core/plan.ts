import { randomUUID } from "node:crypto";
import {
  mkdir,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, posix, relative, resolve, sep } from "node:path";
import { unzipSync } from "fflate";
import { readConfig } from "./config.js";
import { execute, git } from "./process.js";
import { assertTests, identify, runtime } from "./salesforce.js";
import {
  canonical,
  clean,
  commit,
  hash,
  json,
  receipts,
  refresh,
  requireBaseline,
  root,
  save,
} from "./storage.js";
import {
  SfciError,
  type Options,
  type Plan,
  type TargetOptions,
} from "./types.js";

const TOOLCHAIN = "sfci/0.1.0-alpha.1;sgd/6.45.1;sf/2.156.8";
type SalesforceProject = {
  packageDirectories?: { path?: unknown }[];
  sourceApiVersion?: string;
};

async function trackedText(
  cwd: string,
  ref: string,
  file: string,
): Promise<string | null> {
  if (!(await git(cwd, "ls-tree", "--name-only", ref, "--", file))) return null;
  const result = await execute("git", ["show", `${ref}:${file}`], cwd);
  if (result.code)
    throw new SfciError(
      "Cannot inspect the baseline's managed scope.",
      undefined,
      "GIT",
    );
  return result.stdout.toString();
}

function managedScope(project: SalesforceProject, ignore: string): string {
  const directories = project.packageDirectories;
  if (
    !Array.isArray(directories) ||
    directories.some((entry) => typeof entry.path !== "string")
  )
    throw new SfciError(
      "The baseline does not define a comparable Salesforce package scope.",
      "Reconcile the baseline and prepare a plan with --mode full.",
      "SCOPE_CHANGED",
    );
  return canonical({
    directories: [
      ...new Set(
        directories.map((entry) =>
          posix.normalize((entry.path as string).replaceAll("\\", "/")),
        ),
      ),
    ].sort(),
    apiVersion:
      project.sourceApiVersion === undefined
        ? null
        : String(project.sourceApiVersion),
    ignore: ignore.replaceAll("\r\n", "\n"),
  });
}

async function assertDeltaScopeUnchanged(
  cwd: string,
  from: string,
  project: SalesforceProject,
  ignore: string,
): Promise<void> {
  const baselineProject = await trackedText(cwd, from, "sfdx-project.json");
  let baseline: SalesforceProject | null = null;
  try {
    baseline = baselineProject
      ? (JSON.parse(baselineProject) as SalesforceProject)
      : null;
  } catch {
    /* A full plan is required when the old scope cannot be compared. */
  }
  const baselineIgnore = await trackedText(cwd, from, ".forceignore");
  if (
    !baseline ||
    managedScope(baseline, baselineIgnore ?? "") !==
      managedScope(project, ignore)
  )
    throw new SfciError(
      "Managed scope changed since the environment baseline.",
      "Changes to .forceignore, packageDirectories, or sourceApiVersion require --mode full so unchanged metadata entering the scope is included.",
      "SCOPE_CHANGED",
    );
}
export async function fileHashes(
  directory: string,
  prefix = "",
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(resolve(directory, prefix), {
    withFileTypes: true,
  })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new SfciError(
        `Unexpected symbolic link in plan: ${name}.`,
        undefined,
        "ARTIFACT",
      );
    if (entry.isDirectory())
      Object.assign(files, await fileHashes(directory, name));
    else if (entry.isFile())
      files[name] = hash(await readFile(resolve(directory, name)));
    else
      throw new SfciError(
        `Unsupported plan entry: ${name}.`,
        undefined,
        "ARTIFACT",
      );
  }
  return files;
}
export function manifestMembers(xml: string): string[] {
  const entries: string[] = [];
  for (const group of xml.matchAll(/<types>([\s\S]*?)<\/types>/g)) {
    const name = /<name>([^<]+)<\/name>/.exec(group[1] ?? "")?.[1];
    if (!name) continue;
    for (const member of (group[1] ?? "").matchAll(
      /<members>([^<]+)<\/members>/g,
    ))
      entries.push(`${name}:${member[1]}`);
  }
  return entries;
}
function binding(plan: Plan): Omit<Plan, "id" | "path"> {
  const { id: _id, path: _path, ...rest } = plan;
  return rest;
}
export async function loadPlan(path: string): Promise<Plan> {
  const resolved = resolve(path);
  const plan = await json<Plan>(resolved);
  if (
    plan.schemaVersion !== 1 ||
    !plan.id ||
    !/^[a-f0-9]{64}$/.test(plan.id) ||
    hash(canonical(binding(plan))) !== plan.id
  ) {
    throw new SfciError(
      "Plan contents have changed or are unsupported.",
      "Create a new plan from the intended Git commit.",
      "PLAN_CHANGED",
    );
  }
  const actual = await fileHashes(resolve(dirname(resolved), "content"));
  if (canonical(actual) !== canonical(plan.files))
    throw new SfciError(
      "Plan files have changed since preparation.",
      "Create a new plan; validation applies only to the original files.",
      "PLAN_CHANGED",
    );
  return { ...plan, path: resolved };
}
export async function assertCurrent(
  options: Options,
  plan: Plan,
): Promise<void> {
  const cwd = await root(options.cwd);
  const config = await readConfig(cwd);
  if (hash(canonical(config)) !== plan.configHash)
    throw new SfciError(
      "Configuration changed after the plan was created.",
      "Create a new plan with the current configuration.",
      "STALE_PLAN",
    );
  if (plan.toolchain !== TOOLCHAIN)
    throw new SfciError(
      "The plan was created with a different toolchain.",
      "Create a new plan with this sfci version.",
      "STALE_PLAN",
    );
  const target = config.environments[plan.target];
  if (!target || target.org !== plan.org)
    throw new SfciError(
      "The plan target does not match configuration.",
      undefined,
      "STALE_PLAN",
    );
  const org = await identify(options, plan.org);
  if (org.orgId !== plan.orgId || org.production !== plan.production)
    throw new SfciError(
      "The org behind this alias changed.",
      "Reconcile the refreshed org and set its baseline again.",
      "ORG_CHANGED",
    );
  const latest = await requireBaseline(cwd, plan.target);
  if (latest.orgId !== plan.orgId || latest.tag !== plan.baselineTag)
    throw new SfciError(
      "The environment baseline changed after this plan was prepared.",
      "Create a fresh plan from the current deployment receipt.",
      "STALE_PLAN",
    );
}
export async function createPlan(
  options: TargetOptions & { ref?: string; mode?: "delta" | "full" },
): Promise<Plan> {
  const cwd = await root(options.cwd);
  const config = await readConfig(cwd);
  const env = config.environments[options.target];
  if (!env)
    throw new SfciError(
      `Unknown environment ${options.target}.`,
      "Choose an environment from sfci.yml.",
      "CONFIG",
    );
  await clean(cwd);
  await refresh(cwd, config.trunk);
  const base = await requireBaseline(cwd, options.target);
  const to = await commit(cwd, options.ref ?? "HEAD");
  const from = base.commit;
  const origin = (await git(cwd, "remote")).split("\n").includes("origin");
  const trunk = await commit(
    cwd,
    origin ? `refs/remotes/origin/${config.trunk}` : config.trunk,
  );
  let promotionReceipt: string | null = null;
  if (env.promoteFrom) {
    const source = (await receipts(cwd, env.promoteFrom)).find(
      (receipt) => receipt.kind === "deployment" && receipt.commit === to,
    );
    if (!source)
      throw new SfciError(
        `This commit has no successful deployment receipt in ${env.promoteFrom}.`,
        "Choose a frozen release that was deployed to the promotion source.",
        "RELEASE",
      );
    promotionReceipt = source.tag;
  } else {
    try {
      await git(cwd, "merge-base", "--is-ancestor", trunk, to);
    } catch {
      throw new SfciError(
        "The candidate is behind the current trunk.",
        `Merge or rebase ${config.trunk}, then validate the updated candidate.`,
        "STALE_CANDIDATE",
      );
    }
  }
  try {
    await git(cwd, "merge-base", "--is-ancestor", from, to);
  } catch {
    throw new SfciError(
      "The org baseline is not an ancestor of the candidate.",
      "Reconcile the Git history and org state. Full mode does not bypass this check.",
      "HISTORY",
    );
  }
  const org = await identify({ ...options, cwd }, env.org);
  if (org.orgId !== base.orgId)
    throw new SfciError(
      "The org no longer matches its baseline.",
      "After an org refresh, record a verified baseline for the new org.",
      "ORG_CHANGED",
    );
  assertTests({ ...org, tests: env.tests });
  const temporary = resolve(cwd, ".sfci", "tmp", randomUUID());
  const content = resolve(temporary, "content");
  const payload = resolve(content, "source");
  await mkdir(payload, { recursive: true });
  try {
    const tree = await git(cwd, "ls-tree", "-r", to);
    if (tree.split("\n").some((line) => /^(120000|160000) /.test(line)))
      throw new SfciError(
        "The source commit contains symbolic links or submodules.",
        "Use regular tracked files for reproducible deployment snapshots.",
        "SOURCE",
      );
    const archive = await execute("git", ["archive", "--format=zip", to], cwd);
    if (archive.code)
      throw new SfciError(
        "Could not snapshot the source commit.",
        undefined,
        "SOURCE",
      );
    for (const [name, data] of Object.entries(unzipSync(archive.stdout))) {
      if (
        Buffer.from(data.subarray(0, 80))
          .toString()
          .startsWith("version https://git-lfs.github.com/spec/v1\n")
      ) {
        throw new SfciError(
          `The source snapshot contains a Git LFS pointer: ${name}.`,
          "Git LFS payload materialization is not supported in this alpha. sfci will not deploy pointer text as metadata.",
          "UNSUPPORTED",
        );
      }
      const destination = resolve(payload, name);
      if (
        relative(payload, destination).startsWith(`..${sep}`) ||
        destination === payload ||
        name.startsWith("/") ||
        name.includes("\\")
      ) {
        throw new SfciError(
          "Unsafe path in source archive.",
          undefined,
          "SOURCE",
        );
      }
      if (name.endsWith("/")) {
        await mkdir(destination, { recursive: true });
        continue;
      }
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, data);
    }
    const project = await json<SalesforceProject>(
      resolve(payload, "sfdx-project.json"),
    );
    if (
      !Array.isArray(project.packageDirectories) ||
      !project.packageDirectories.length
    )
      throw new SfciError(
        "No Salesforce package directories configured.",
        "Set packageDirectories in sfdx-project.json.",
        "PROJECT",
      );
    const source = project.packageDirectories.map((item) => {
      if (
        typeof item.path !== "string" ||
        !item.path ||
        item.path.startsWith("/") ||
        item.path.split(/[\\/]/).includes("..")
      )
        throw new SfciError(
          "Invalid package directory in sfdx-project.json.",
          undefined,
          "PROJECT",
        );
      return item.path;
    });
    const deltaDirectory = resolve(content, "delta");
    await mkdir(deltaDirectory, { recursive: true });
    const ignore = resolve(payload, ".forceignore");
    let ignoreExists = false;
    let ignoreText = "";
    try {
      ignoreText = await readFile(ignore, "utf8");
      ignoreExists = true;
    } catch {
      /* .forceignore is optional. */
    }
    if (options.mode !== "full")
      await assertDeltaScopeUnchanged(cwd, from, project, ignoreText);
    const { default: sgd } = await import("sfdx-git-delta");
    const result = await sgd({
      from,
      to,
      output: deltaDirectory,
      repo: cwd,
      source,
      generateDelta: false,
      ignoreWhitespace: false,
      ...(ignoreExists ? { ignore, ignoreDestructive: ignore } : {}),
      ...(project.sourceApiVersion
        ? { apiVersion: Number(project.sourceApiVersion) }
        : {}),
    });
    if (result.warnings.length)
      throw new SfciError(
        "Git Delta reported warnings; the plan was not accepted.",
        result.warnings.map((error) => error.message).join("\n"),
        "DELTA",
      );
    const constructive = manifestMembers(
      await readFile(resolve(deltaDirectory, "package", "package.xml"), "utf8"),
    );
    const destructive = manifestMembers(
      await readFile(
        resolve(deltaDirectory, "destructiveChanges", "destructiveChanges.xml"),
        "utf8",
      ),
    );
    if (
      destructive.some(
        (item) =>
          item.startsWith("Flow:") || item.startsWith("FlowDefinition:"),
      )
    )
      throw new SfciError(
        "Versioned Flow deletion is not supported in this alpha.",
        "Remove Flow deletions from this release and handle their versions explicitly in Salesforce.",
        "UNSUPPORTED",
      );
    const plan: Plan = {
      schemaVersion: 1,
      id: "",
      path: "",
      target: options.target,
      org: env.org,
      ...org,
      from,
      to,
      baselineTag: base.tag,
      trunk: config.trunk,
      mode: options.mode ?? "delta",
      tests: env.tests,
      components: constructive.length,
      destructive,
      empty:
        options.mode !== "full" &&
        constructive.length === 0 &&
        destructive.length === 0,
      files: await fileHashes(content),
      configHash: hash(canonical(config)),
      toolchain: TOOLCHAIN,
      promotionReceipt,
    };
    plan.id = hash(canonical(binding(plan)));
    const destination = resolve(cwd, ".sfci", "plans", plan.id);
    plan.path = resolve(destination, "plan.json");
    await mkdir(dirname(destination), { recursive: true });
    try {
      await rename(temporary, destination);
    } catch (error) {
      const prior = await loadPlan(plan.path).catch(() => null);
      if (!prior) throw error;
      await rm(temporary, { recursive: true, force: true });
      return prior;
    }
    await save(plan.path, plan);
    return plan;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function withExecutionWorkspace<T>(
  plan: Plan,
  options: Options,
  task: (workspace: string) => Promise<T>,
): Promise<T> {
  const workRoot = resolve(await root(options.cwd), ".sfci", "work");
  await mkdir(workRoot, { recursive: true });
  const workspace = await mkdtemp(
    resolve(workRoot, `${plan.id.slice(0, 12)}-`),
  );
  try {
    await cp(resolve(dirname(plan.path), "content", "source"), workspace, {
      recursive: true,
    });
    return await task(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function deploymentArgs(
  plan: Plan,
  workspace: string,
  options: Options,
): Promise<string[]> {
  const content = resolve(dirname(plan.path), "content");
  const args = ["--target-org", plan.org, "--test-level", plan.tests];
  if (plan.mode === "full") {
    const project = await json<{ packageDirectories: { path: string }[] }>(
      resolve(workspace, "sfdx-project.json"),
    );
    const sourceArgs = project.packageDirectories.flatMap((item) => [
      "--source-dir",
      resolve(workspace, item.path),
    ]);
    // Destructive flags require --manifest. It also avoids caching --source-dir paths
    // into a disposable workspace, so the job can be reported from a later workspace.
    const output = resolve(workspace, ".sfci-manifests");
    await runtime(options).sf(
      [
        "project",
        "generate",
        "manifest",
        ...sourceArgs,
        "--output-dir",
        output,
      ],
      workspace,
    );
    const manifest = resolve(output, "package.xml");
    await readFile(manifest, "utf8");
    args.push("--manifest", manifest);
  } else
    args.push(
      "--manifest",
      resolve(
        content,
        "delta",
        plan.components
          ? "package/package.xml"
          : "destructiveChanges/package.xml",
      ),
    );
  if (plan.destructive.length)
    args.push(
      "--post-destructive-changes",
      resolve(content, "delta", "destructiveChanges/destructiveChanges.xml"),
    );
  return args;
}
