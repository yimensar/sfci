import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { readConfig } from "./config.js";
import {
  assertNoRemoteClaim,
  checkpoint,
  hasOrigin,
  pendingError,
  releaseClaim,
  remoteClaim,
  type Claim,
} from "./coordination.js";
import {
  assertCurrent,
  createPlan,
  deploymentArgs,
  loadPlan,
  withExecutionWorkspace,
} from "./plan.js";
import { git, privateSalesforceCli } from "./process.js";
import {
  assertOrgType,
  identify,
  jobId,
  runtime,
  waitForJob,
} from "./salesforce.js";
import {
  baseline,
  canonical,
  commit,
  hash,
  json,
  locked,
  receipts,
  refresh,
  requireBaseline,
  root,
  save,
  writeReceipt,
} from "./storage.js";
import {
  JobFailedError,
  SfciError,
  type Operation,
  type Options,
  type Plan,
  type Receipt,
  type Release,
  type TargetOptions,
  type Validation,
} from "./types.js";

export { readConfig, createPlan, loadPlan, SfciError };
export type {
  Config,
  Environment,
  Plan,
  Receipt,
  Release,
  Runtime,
  Validation,
} from "./types.js";

const operationFile = (cwd: string, target: string): string =>
  resolve(cwd, ".sfci", "operations", `${target}.json`);
const validationFile = (plan: Plan): string =>
  resolve(dirname(plan.path), "validation.json");
function reusableValidation(value: unknown, plan: Plan): value is Validation {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const cached = value as Record<string, unknown>;
  if (
    cached.schemaVersion !== 1 ||
    cached.planId !== plan.id ||
    cached.orgId !== plan.orgId ||
    cached.baselineTag !== plan.baselineTag ||
    cached.status !== (plan.empty ? "Empty" : "Succeeded") ||
    cached.quickDeploy !== (plan.production && !plan.empty) ||
    typeof cached.completedAt !== "string"
  )
    return false;

  const timestamp = Date.parse(cached.completedAt);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== cached.completedAt
  )
    return false;
  const age = Date.now() - timestamp;
  if (age < 0 || age >= 9 * 24 * 60 * 60 * 1000) return false;

  return plan.empty
    ? cached.jobId === null
    : typeof cached.jobId === "string" &&
        /^0Af[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(cached.jobId);
}
function matchTarget(plan: Plan, target?: string): void {
  if (target !== undefined && plan.target !== target)
    throw new SfciError(
      `This plan targets ${plan.target}, not ${target}.`,
      "Use the intended target or create a new plan.",
      "TARGET",
    );
}
async function fetchState(options: Options): Promise<string> {
  const cwd = await root(options.cwd);
  const config = await readConfig(cwd);
  await refresh(cwd, config.trunk);
  return cwd;
}
function makeReceipt(
  target: string,
  orgId: string,
  sha: string,
  prior: Receipt | null,
  planId: string | null,
  id: string | null,
): Receipt {
  const sequence = (prior?.sequence ?? 0) + 1;
  return {
    schemaVersion: 1,
    kind: planId ? "deployment" : "baseline",
    status: "success",
    target,
    orgId,
    commit: sha,
    sequence,
    tag: `sfci/${target}/${String(sequence).padStart(10, "0")}-${sha.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
    predecessor: prior?.tag ?? null,
    planId,
    jobId: id,
    completedAt: new Date().toISOString(),
  };
}
export async function doctor(options: Options & { target?: string }): Promise<{
  ok: boolean;
  checks: { name: string; status: "passed" | "failed"; detail: string }[];
}> {
  const checks: {
    name: string;
    status: "passed" | "failed";
    detail: string;
  }[] = [];
  const check = async (
    name: string,
    fn: () => Promise<string>,
  ): Promise<void> => {
    try {
      checks.push({ name, status: "passed", detail: await fn() });
    } catch (error) {
      checks.push({
        name,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  await check("Git", async () => root(options.cwd));
  await check("Configuration", async () => {
    const config = await readConfig(options.cwd);
    return `${config.trunk}; ${Object.keys(config.environments).join(", ")}`;
  });
  await check("Bundled Salesforce CLI", async () => {
    const path = privateSalesforceCli();
    await access(path);
    return path;
  });
  if (options.target) {
    const target = options.target;
    await check("Salesforce org", async () => {
      const env = (await readConfig(options.cwd)).environments[target];
      if (!env) throw new SfciError(`Unknown environment ${target}.`);
      const org = await identify(options, env.org);
      assertOrgType(env, org);
      return `${org.orgId} (${org.production ? "production" : "sandbox"})`;
    });
    await check(
      "Baseline",
      async () => (await requireBaseline(options.cwd, target)).tag,
    );
  }
  return { ok: checks.every((check) => check.status === "passed"), checks };
}
export async function status(options: Options & { target?: string }): Promise<{
  trunk: string;
  environments: {
    target: string;
    org: string;
    receipt: Receipt | null;
    pending: Operation | null;
  }[];
}> {
  const cwd = await fetchState(options);
  const config = await readConfig(cwd);
  const targets = options.target
    ? [options.target]
    : Object.keys(config.environments);
  const environments = [];
  for (const target of targets) {
    const env = config.environments[target];
    if (!env)
      throw new SfciError(
        `Unknown environment ${target}.`,
        undefined,
        "CONFIG",
      );
    let pending: Operation | null = null;
    try {
      await access(operationFile(cwd, target));
      pending = await json<Operation>(operationFile(cwd, target));
    } catch (error) {
      if (error instanceof SfciError) throw error;
    }
    const receipt = await baseline(cwd, target);
    const remote = receipt ? await remoteClaim(cwd, receipt.orgId) : null;
    if (remote?.value.operation) pending = remote.value.operation;
    environments.push({
      target,
      org: env.org,
      receipt,
      pending,
      checkpoint: remote?.value ?? null,
    });
  }
  return { trunk: config.trunk, environments };
}
export async function setBaseline(
  options: TargetOptions & { commit: string; push?: boolean },
): Promise<Receipt> {
  const cwd = await fetchState(options);
  const config = await readConfig(cwd);
  const env = config.environments[options.target];
  if (!env)
    throw new SfciError(
      `Unknown environment ${options.target}.`,
      undefined,
      "CONFIG",
    );
  const sha = await commit(cwd, options.commit);
  const org = await identify({ ...options, cwd }, env.org);
  assertOrgType(env, org);
  return locked(cwd, org.orgId, async () => {
    await assertNoRemoteClaim(cwd, org.orgId);
    await refresh(cwd, config.trunk);
    try {
      await access(operationFile(cwd, options.target));
      throw new SfciError(
        "An unfinished deployment must be reconciled first.",
        `Run sfci resume --target ${options.target}.`,
        "PENDING",
      );
    } catch (error) {
      if (error instanceof SfciError) throw error;
    }
    const push = options.push ?? (await hasOrigin(cwd));
    const claim = push
      ? await checkpoint(
          cwd,
          {
            schemaVersion: 1,
            target: options.target,
            orgId: org.orgId,
            commit: sha,
            operation: null,
          },
          null,
        )
      : null;
    await refresh(cwd, config.trunk);
    const receipt = makeReceipt(
      options.target,
      org.orgId,
      sha,
      await baseline(cwd, options.target),
      null,
      null,
    );
    await writeReceipt(cwd, receipt, push);
    if (claim) await releaseClaim(cwd, claim);
    return receipt;
  });
}
export async function validatePlan(
  options: Options & { planPath: string; target?: string; refresh?: boolean },
): Promise<Validation> {
  const cwd = await fetchState(options);
  const plan = await loadPlan(options.planPath);
  matchTarget(plan, options.target);
  return locked(cwd, plan.orgId, async () => {
    await assertNoRemoteClaim(cwd, plan.orgId);
    await refresh(cwd, plan.trunk);
    await assertCurrent({ ...options, cwd }, plan);
    let previous: unknown;
    try {
      previous = await json<unknown>(validationFile(plan));
    } catch {
      /* No readable cached validation. */
    }
    if (!options.refresh && reusableValidation(previous, plan)) return previous;
    let id: string | null = null;
    if (!plan.empty) {
      id = await withExecutionWorkspace(plan, options, async (workspace) => {
        const args = await deploymentArgs(plan, workspace, options);
        const result = await runtime(options).sf(
          [
            "project",
            "deploy",
            plan.production ? "validate" : "start",
            ...args,
            ...(plan.production ? [] : ["--dry-run", "--ignore-conflicts"]),
            "--async",
          ],
          workspace,
        );
        const accepted = jobId(result);
        await waitForJob({ ...options, cwd: workspace }, plan.org, accepted);
        return accepted;
      });
    }
    const result: Validation = {
      schemaVersion: 1,
      planId: plan.id,
      orgId: plan.orgId,
      baselineTag: plan.baselineTag,
      jobId: id,
      status: plan.empty ? "Empty" : "Succeeded",
      quickDeploy: plan.production && !plan.empty,
      completedAt: new Date().toISOString(),
    };
    await save(validationFile(plan), result);
    return result;
  });
}
async function recordSuccess(
  options: Options & { push?: boolean },
  plan: Plan,
  operation: Operation,
  claim: Claim | null,
): Promise<Receipt> {
  const cwd = await root(options.cwd);
  let receipt = operation.receipt;
  if (!receipt) {
    const previous = await requireBaseline(cwd, plan.target);
    // An old artifact may predate publication, even after a later deployment.
    receipt = (await receipts(cwd, plan.target)).find(
      (value) =>
        value.kind === "deployment" &&
        value.planId === plan.id &&
        value.orgId === plan.orgId &&
        value.commit === plan.to &&
        value.jobId === operation.jobId,
    );
    if (!receipt && previous.tag !== plan.baselineTag)
      throw new SfciError(
        "Another receipt advanced the baseline while the deployment was running.",
        "Reconcile the org and receipt history; this successful operation remains recorded locally.",
        "CONCURRENT_DEPLOYMENT",
      );
    receipt ??= makeReceipt(
      plan.target,
      plan.orgId,
      plan.to,
      previous,
      plan.id,
      operation.jobId,
    );
    operation = { ...operation, phase: "succeeded", receipt };
    await save(operationFile(cwd, plan.target), operation);
    if (claim)
      claim = await checkpoint(cwd, { ...claim.value, operation }, claim);
  }
  try {
    await writeReceipt(cwd, receipt, options.push ?? (await hasOrigin(cwd)));
    if (claim) await releaseClaim(cwd, claim);
  } catch (error) {
    throw new SfciError(
      "Salesforce succeeded, but its deployment receipt could not be published.",
      `Do not redeploy. Run sfci resume --target ${plan.target} to retry recording it. ${error instanceof Error ? error.message : ""}`,
      "RECEIPT_PENDING",
    );
  }
  await rm(operationFile(cwd, plan.target), { force: true });
  return receipt;
}
async function assertDeployable(cwd: string, plan: Plan): Promise<void> {
  const config = await readConfig(cwd);
  const trunk = await commit(
    cwd,
    (await hasOrigin(cwd))
      ? `refs/remotes/origin/${config.trunk}`
      : config.trunk,
  );
  try {
    await git(cwd, "merge-base", "--is-ancestor", plan.to, trunk);
  } catch {
    throw new SfciError(
      "Deployment requires a commit already merged into the trunk.",
      `Merge and validate the change in ${config.trunk} first.`,
      "TRUNK",
    );
  }
  const environment = config.environments[plan.target];
  if (environment?.promoteFrom) {
    const receipt = (await receipts(cwd, environment.promoteFrom)).find(
      (receipt) => receipt.tag === plan.promotionReceipt,
    );
    if (!receipt || receipt.kind !== "deployment" || receipt.commit !== plan.to)
      throw new SfciError(
        "The plan has no matching successful promotion-source receipt.",
        "Create a plan from a frozen release deployed in the configured source environment.",
        "RELEASE",
      );
  } else if (plan.to !== trunk) {
    throw new SfciError(
      "This deployment candidate is no longer the current trunk.",
      "Deploy the current trunk instead of an obsolete CI candidate.",
      "STALE_CANDIDATE",
    );
  }
}
export async function applyPlan(
  options: Options & {
    planPath: string;
    target?: string;
    allowDestructive?: boolean;
    push?: boolean;
  },
): Promise<Receipt> {
  const cwd = await fetchState(options);
  const plan = await loadPlan(options.planPath);
  matchTarget(plan, options.target);
  if (plan.destructive.length && !options.allowDestructive)
    throw new SfciError(
      "The plan includes metadata deletions.",
      "Review the plan, then pass --allow-destructive to deploy those deletions.",
      "DESTRUCTIVE",
    );
  await assertDeployable(cwd, plan);
  // Validation holds its own lock. The apply lock is acquired afterwards and checks the baseline again.
  const validation = plan.production
    ? await validatePlan({
        ...options,
        planPath: plan.path,
        target: plan.target,
      })
    : null;
  return locked(cwd, plan.orgId, async () => {
    await assertNoRemoteClaim(cwd, plan.orgId);
    await refresh(cwd, plan.trunk);
    await assertCurrent({ ...options, cwd }, plan);
    await assertDeployable(cwd, plan);
    try {
      await access(operationFile(cwd, plan.target));
      throw new SfciError(
        "An earlier deployment has an unfinished operation record.",
        `Run sfci resume --target ${plan.target} before submitting another deployment.`,
        "PENDING",
      );
    } catch (error) {
      if (error instanceof SfciError) throw error;
    }
    let operation: Operation = {
      schemaVersion: 1,
      target: plan.target,
      orgId: plan.orgId,
      planPath: relative(cwd, plan.path),
      planId: plan.id,
      jobId: null,
      phase: "submitting",
    };
    const push = options.push ?? (await hasOrigin(cwd));
    let claim: Claim | null = push
      ? await checkpoint(
          cwd,
          {
            schemaVersion: 1,
            target: plan.target,
            orgId: plan.orgId,
            commit: plan.to,
            operation,
          },
          null,
        )
      : null;
    // Once reserved, refresh again: another runner may just have published its receipt.
    try {
      await refresh(cwd, plan.trunk);
      await assertCurrent({ ...options, cwd }, plan);
      await assertDeployable(cwd, plan);
    } catch (error) {
      if (claim) await releaseClaim(cwd, claim);
      throw error;
    }
    const persist = async (): Promise<void> => {
      await save(operationFile(cwd, plan.target), operation);
      if (claim)
        claim = await checkpoint(cwd, { ...claim.value, operation }, claim);
    };
    if (!plan.empty) {
      await withExecutionWorkspace(plan, options, async (workspace) => {
        const args =
          validation?.quickDeploy && validation.jobId
            ? [
                "project",
                "deploy",
                "quick",
                "--target-org",
                plan.org,
                "--job-id",
                validation.jobId,
                "--async",
              ]
            : [
                "project",
                "deploy",
                "start",
                ...(await deploymentArgs(plan, workspace, options)),
                "--ignore-conflicts",
                "--async",
              ];
        await save(operationFile(cwd, plan.target), operation);
        let submission: Record<string, unknown>;
        try {
          submission = await runtime(options).sf(args, workspace);
        } catch {
          throw new SfciError(
            "Deployment submission did not return a confirmed job ID.",
            "Inspect Deployment Status before retrying. The local operation record intentionally blocks a second submission.",
            "SUBMISSION_UNKNOWN",
          );
        }
        operation = {
          ...operation,
          jobId: jobId(submission),
          phase: "running",
        };
        await persist();
        try {
          await waitForJob(
            { ...options, cwd: workspace },
            plan.org,
            operation.jobId!,
          );
        } catch (error) {
          if (
            error instanceof JobFailedError &&
            error.result.rollbackOnError === true
          ) {
            if (claim) await releaseClaim(cwd, claim);
            await rm(operationFile(cwd, plan.target), { force: true });
          }
          throw error;
        }
      });
    } else {
      await persist();
    }
    operation = { ...operation, phase: "succeeded" };
    await persist();
    return recordSuccess({ ...options, cwd }, plan, operation, claim);
  });
}
export async function createRelease(
  options: Options & { from: string; output: string },
): Promise<Release> {
  const cwd = await fetchState(options);
  const config = await readConfig(cwd);
  const env = config.environments[options.from];
  if (!env)
    throw new SfciError(
      `Unknown environment ${options.from}.`,
      undefined,
      "CONFIG",
    );
  const receipt = await requireBaseline(cwd, options.from);
  if (receipt.kind !== "deployment")
    throw new SfciError(
      "A release requires a successful sfci deployment in its source environment.",
      `Deploy and verify the candidate in ${options.from} first.`,
      "RELEASE",
    );
  const org = await identify({ ...options, cwd }, env.org);
  assertOrgType(env, org);
  if (org.orgId !== receipt.orgId)
    throw new SfciError(
      "The source org no longer matches its deployment receipt.",
      undefined,
      "ORG_CHANGED",
    );
  const release: Release = {
    schemaVersion: 1,
    commit: receipt.commit,
    from: options.from,
    receiptTag: receipt.tag,
    orgId: receipt.orgId,
  };
  await save(resolve(cwd, options.output), release);
  return release;
}
export async function deploy(
  options: TargetOptions & {
    ref?: string;
    mode?: "delta" | "full";
    releasePath?: string;
    allowDestructive?: boolean;
    push?: boolean;
  },
): Promise<Receipt> {
  const cwd = await root(options.cwd);
  const config = await readConfig(cwd);
  const env = config.environments[options.target];
  if (!env)
    throw new SfciError(
      `Unknown environment ${options.target}.`,
      undefined,
      "CONFIG",
    );
  let ref = options.ref;
  if (env.promoteFrom && !options.releasePath)
    throw new SfciError(
      `Deploying ${options.target} requires a frozen release from ${env.promoteFrom}.`,
      `Run sfci release --from ${env.promoteFrom} --output release.json first.`,
      "RELEASE",
    );
  if (options.releasePath) {
    await refresh(cwd, config.trunk);
    const release = await json<Release>(resolve(cwd, options.releasePath));
    if (
      release.schemaVersion !== 1 ||
      release.from !== env.promoteFrom ||
      typeof release.receiptTag !== "string"
    )
      throw new SfciError(
        "The release does not match the configured promotion source.",
        undefined,
        "RELEASE",
      );
    const tagCommit = await commit(cwd, release.receiptTag);
    const receipt = JSON.parse(
      await git(
        cwd,
        "for-each-ref",
        "--format=%(contents)",
        `refs/tags/${release.receiptTag}`,
      ),
    ) as Receipt;
    if (
      receipt.kind !== "deployment" ||
      receipt.status !== "success" ||
      receipt.target !== release.from ||
      receipt.commit !== release.commit ||
      receipt.orgId !== release.orgId ||
      tagCommit !== release.commit
    )
      throw new SfciError(
        "The release does not match its successful deployment receipt.",
        undefined,
        "RELEASE",
      );
    ref = release.commit;
  }
  const plan = await createPlan({
    cwd,
    target: options.target,
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(ref ? { ref } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  });
  return applyPlan({ ...options, cwd, planPath: plan.path });
}
export async function resume(
  options: TargetOptions & { push?: boolean },
): Promise<Receipt> {
  const cwd = await fetchState(options);
  const env = (await readConfig(cwd)).environments[options.target];
  if (!env)
    throw new SfciError(
      `Unknown environment ${options.target}.`,
      undefined,
      "CONFIG",
    );
  const org = await identify({ ...options, cwd }, env.org);
  assertOrgType(env, org);
  let claim = await remoteClaim(cwd, org.orgId);
  if (
    claim &&
    (claim.value.target !== options.target || !claim.value.operation)
  )
    throw pendingError(claim);
  const push = options.push ?? (await hasOrigin(cwd));
  if (claim && !push)
    throw new SfciError(
      "This operation is coordinated on origin.",
      "Resume it with --push to publish its receipt and clear the checkpoint.",
      "REMOTE_STATE",
    );
  let operation: Operation | undefined;
  try {
    await access(operationFile(cwd, options.target));
    operation = await json<Operation>(operationFile(cwd, options.target));
  } catch (error) {
    if (error instanceof SfciError) throw error;
  }
  const remote = claim?.value.operation;
  if (remote) {
    if (
      operation &&
      (operation.planId !== remote.planId ||
        (operation.jobId && remote.jobId && operation.jobId !== remote.jobId))
    )
      throw new SfciError(
        "Local and remote operations disagree.",
        "Inspect both checkpoints before continuing.",
        "OPERATION",
      );
    const phases = ["submitting", "running", "succeeded"];
    if (
      !operation ||
      phases.indexOf(remote.phase) > phases.indexOf(operation.phase) ||
      remote.receipt
    )
      operation = remote;
  }
  if (!operation)
    throw new SfciError(
      "No pending operation for this target.",
      "Run sfci status to inspect recorded deployments.",
      "OPERATION",
    );
  if (
    operation.schemaVersion !== 1 ||
    operation.target !== options.target ||
    !/^[a-f0-9]{64}$/.test(operation.planId) ||
    !["submitting", "running", "succeeded"].includes(operation.phase)
  )
    throw new SfciError("Invalid operation record.", undefined, "OPERATION");
  const planPath = resolve(
    cwd,
    ".sfci",
    "plans",
    operation.planId,
    "plan.json",
  );
  try {
    await access(planPath);
  } catch {
    throw new SfciError(
      "The pending operation's plan artifact is missing.",
      "Restore its .sfci/plans directory from the original CI run, then resume. If the artifact was lost, reconcile Salesforce Deployment Status before clearing the remote checkpoint.",
      "ARTIFACT",
    );
  }
  const plan = await loadPlan(planPath);
  matchTarget(plan, options.target);
  if (operation.planId !== plan.id || operation.orgId !== plan.orgId)
    throw new SfciError(
      "The operation does not match its original plan.",
      undefined,
      "OPERATION",
    );
  if (
    !plan.empty &&
    operation.phase !== "submitting" &&
    (typeof operation.jobId !== "string" ||
      !/^0Af[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(operation.jobId))
  )
    throw new SfciError(
      "The operation has no valid Salesforce job ID.",
      undefined,
      "OPERATION",
    );
  if (
    operation.receipt &&
    (operation.receipt.planId !== plan.id ||
      operation.receipt.target !== plan.target ||
      operation.receipt.orgId !== plan.orgId ||
      operation.receipt.commit !== plan.to ||
      operation.receipt.jobId !== operation.jobId ||
      operation.receipt.kind !== "deployment" ||
      operation.receipt.status !== "success")
  )
    throw new SfciError(
      "The pending receipt does not match its operation.",
      undefined,
      "OPERATION",
    );
  return locked(cwd, plan.orgId, async () => {
    const org = await identify({ ...options, cwd }, plan.org);
    assertOrgType(env, org);
    if (org.orgId !== plan.orgId)
      throw new SfciError(
        "The org identity changed after submission.",
        undefined,
        "ORG_CHANGED",
      );
    if (operation.phase === "submitting" && !plan.empty)
      throw new SfciError(
        "The previous submission has no confirmed Salesforce job ID.",
        "Inspect Deployment Status and reconcile the org before removing the operation record. sfci will not guess or submit it again.",
        "SUBMISSION_UNKNOWN",
      );
    if (push)
      claim = await checkpoint(
        cwd,
        claim
          ? { ...claim.value, operation }
          : {
              schemaVersion: 1,
              target: plan.target,
              orgId: plan.orgId,
              commit: plan.to,
              operation,
            },
        claim,
      );
    await refresh(cwd, plan.trunk);
    if (operation.phase === "running") {
      try {
        await withExecutionWorkspace(plan, options, (workspace) =>
          waitForJob(
            { ...options, cwd: workspace },
            plan.org,
            operation.jobId!,
          ),
        );
      } catch (error) {
        if (
          error instanceof JobFailedError &&
          error.result.rollbackOnError === true
        ) {
          if (claim) await releaseClaim(cwd, claim);
          await rm(operationFile(cwd, plan.target), { force: true });
        }
        throw error;
      }
    }
    return recordSuccess(
      { ...options, cwd },
      plan,
      {
        ...operation,
        phase: "succeeded",
      },
      claim,
    );
  });
}
