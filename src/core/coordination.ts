import { randomUUID } from "node:crypto";
import { git } from "./process.js";
import { SfciError, type Operation } from "./types.js";

// A single mutable annotated tag is a fail-closed journal, not a job queue.
// Compare-and-swap pushes let Git arbitrate between independent runners.
export interface Checkpoint {
  schemaVersion: 1;
  target: string;
  orgId: string;
  commit: string;
  operation: Operation | null;
}
export interface Claim {
  oid: string;
  value: Checkpoint;
}
export const pendingRef = (orgId: string): string => {
  if (!/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(orgId))
    throw new SfciError("Invalid org identity.", undefined, "ORG");
  return `refs/tags/sfci-pending/${orgId.slice(0, 15)}`;
};
export async function hasOrigin(cwd: string): Promise<boolean> {
  return (await git(cwd, "remote")).split("\n").includes("origin");
}
export async function remoteClaim(
  cwd: string,
  orgId: string,
): Promise<Claim | null> {
  if (!(await hasOrigin(cwd))) return null;
  const ref = pendingRef(orgId);
  if (!(await git(cwd, "ls-remote", "--refs", "origin", ref))) return null;
  const local = `refs/sfci/pending/${randomUUID()}`;
  try {
    await git(cwd, "fetch", "--no-tags", "origin", `${ref}:${local}`);
    const oid = await git(cwd, "rev-parse", local);
    const raw = await git(cwd, "for-each-ref", "--format=%(contents)", local);
    const value = JSON.parse(raw) as Checkpoint;
    if (
      value.schemaVersion !== 1 ||
      value.orgId.slice(0, 15) !== orgId.slice(0, 15) ||
      typeof value.target !== "string" ||
      !/^[a-f0-9]{40,64}$/.test(value.commit) ||
      (value.operation !== null &&
        (value.operation.schemaVersion !== 1 ||
          value.operation.orgId !== value.orgId ||
          value.operation.target !== value.target ||
          !/^[a-f0-9]{64}$/.test(value.operation.planId) ||
          !["submitting", "running", "succeeded"].includes(
            value.operation.phase,
          )))
    )
      throw new Error("Invalid checkpoint");
    return { oid, value };
  } catch (error) {
    throw new SfciError(
      "Cannot read the pending deployment checkpoint from origin.",
      `Inspect ${ref} and Salesforce Deployment Status before continuing. ${error instanceof Error ? error.message : ""}`,
      "REMOTE_STATE",
    );
  } finally {
    await git(cwd, "update-ref", "-d", local);
  }
}
export function pendingError(claim: Claim): SfciError {
  return new SfciError(
    `An unfinished operation for ${claim.value.target} is recorded on origin.`,
    `Run sfci resume --target ${claim.value.target} --push. If its plan artifact was lost, inspect Salesforce Deployment Status and reconcile the org before deleting ${pendingRef(claim.value.orgId)}. Do not submit another deployment.`,
    "PENDING",
  );
}
export async function assertNoRemoteClaim(
  cwd: string,
  orgId: string,
): Promise<void> {
  const pending = await remoteClaim(cwd, orgId);
  if (pending) throw pendingError(pending);
}
export async function checkpoint(
  cwd: string,
  value: Checkpoint,
  previous: Claim | null,
): Promise<Claim> {
  const ref = pendingRef(value.orgId);
  const temporary = `sfci-internal/${randomUUID()}`;
  try {
    await git(
      cwd,
      "-c",
      "user.name=sfci",
      "-c",
      "user.email=sfci@users.noreply.github.com",
      "tag",
      "--annotate",
      temporary,
      value.commit,
      "--message",
      JSON.stringify(value),
    );
    const oid = await git(cwd, "rev-parse", `refs/tags/${temporary}`);
    await git(
      cwd,
      "push",
      "--no-follow-tags",
      `--force-with-lease=${ref}:${previous?.oid ?? ""}`,
      "origin",
      `${oid}:${ref}`,
    );
    return { oid, value };
  } catch (error) {
    throw new SfciError(
      "Could not reserve or update the deployment checkpoint on origin.",
      `Another runner may own this org, or Git write access is unavailable. Run sfci status before retrying. ${error instanceof Error ? error.message : ""}`,
      "REMOTE_STATE",
    );
  } finally {
    await git(cwd, "tag", "--delete", temporary).catch(() => {});
  }
}
export async function releaseClaim(cwd: string, claim: Claim): Promise<void> {
  const ref = pendingRef(claim.value.orgId);
  await git(
    cwd,
    "push",
    "--no-follow-tags",
    `--force-with-lease=${ref}:${claim.oid}`,
    "origin",
    `:${ref}`,
  );
}
