export type TestLevel = "RunLocalTests" | "NoTestRun";
export interface Environment {
  org: string;
  tests: TestLevel;
  promoteFrom?: string;
}
export interface Config {
  trunk: string;
  environments: Record<string, Environment>;
}
export interface Runtime {
  sf(args: string[], cwd: string): Promise<Record<string, unknown>>;
}
export interface Options {
  cwd: string;
  runtime?: Runtime;
}
export interface TargetOptions extends Options {
  target: string;
}
export interface Plan {
  schemaVersion: 1;
  id: string;
  path: string;
  target: string;
  org: string;
  orgId: string;
  production: boolean;
  from: string;
  to: string;
  baselineTag: string;
  trunk: string;
  mode: "delta" | "full";
  tests: TestLevel;
  components: number;
  destructive: string[];
  empty: boolean;
  files: Record<string, string>;
  configHash: string;
  toolchain: string;
  promotionReceipt: string | null;
}
export interface Receipt {
  schemaVersion: 1;
  kind: "baseline" | "deployment";
  status: "success";
  target: string;
  orgId: string;
  commit: string;
  sequence: number;
  tag: string;
  predecessor: string | null;
  planId: string | null;
  jobId: string | null;
  completedAt: string;
}
export interface Validation {
  schemaVersion: 1;
  planId: string;
  orgId: string;
  baselineTag: string;
  jobId: string | null;
  status: "Succeeded" | "Empty";
  quickDeploy: boolean;
  completedAt: string;
}
export interface Release {
  schemaVersion: 1;
  commit: string;
  from: string;
  receiptTag: string;
  orgId: string;
}
export interface Operation {
  schemaVersion: 1;
  target: string;
  orgId: string;
  planPath: string;
  planId: string;
  jobId: string | null;
  phase: "submitting" | "running" | "succeeded";
  receipt?: Receipt;
}
export class SfciError extends Error {
  constructor(
    message: string,
    public hint?: string,
    public code = "SFCI_ERROR",
  ) {
    super(message);
    this.name = "SfciError";
  }
}
export class JobFailedError extends SfciError {
  constructor(
    public jobId: string,
    public result: Record<string, unknown>,
    diagnostics?: string,
  ) {
    super(
      `Salesforce job ${jobId} finished with status ${String(result.status)}.`,
      [
        diagnostics,
        result.rollbackOnError === true
          ? "Salesforce reports rollback-on-error. The baseline was not advanced; correct the failure before retrying."
          : "Inspect Deployment Status and reconcile org state before clearing the local operation record.",
      ]
        .filter(Boolean)
        .join("\n\n"),
      "DEPLOYMENT_FAILED",
    );
  }
}
