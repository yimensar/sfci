import {
  JobFailedError,
  SfciError,
  type Options,
  type Plan,
  type Runtime,
} from "./types.js";
import { defaultRuntime } from "./process.js";
import { redact } from "../redact.js";

export const runtime = (options: Options): Runtime =>
  options.runtime ?? defaultRuntime;
export async function identify(
  options: Options,
  org: string,
): Promise<{ orgId: string; production: boolean }> {
  const result = await runtime(options).sf(
    [
      "data",
      "query",
      "--target-org",
      org,
      "--query",
      "SELECT Id, IsSandbox, OrganizationType FROM Organization LIMIT 1",
    ],
    options.cwd,
  );
  const row = (result.records as Record<string, unknown>[] | undefined)?.[0];
  if (
    !row ||
    typeof row.Id !== "string" ||
    !/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(row.Id) ||
    typeof row.IsSandbox !== "boolean"
  ) {
    throw new SfciError(
      `Cannot identify Salesforce org ${org}.`,
      "Run sfci auth --target <environment> with its JWT credentials, then verify access to the Organization object.",
      "ORG",
    );
  }
  return { orgId: row.Id, production: !row.IsSandbox };
}
export function assertTests(plan: Pick<Plan, "production" | "tests">): void {
  if (plan.production && plan.tests === "NoTestRun")
    throw new SfciError(
      "NoTestRun is not allowed for production.",
      "Use RunLocalTests in sfci.yml.",
      "TEST_LEVEL",
    );
}
export async function waitForJob(
  options: Options,
  org: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 120 * 60 * 1000;
  while (Date.now() < deadline) {
    const result = await runtime(options).sf(
      [
        "project",
        "deploy",
        "report",
        "--target-org",
        org,
        "--job-id",
        jobId,
        "--wait",
        "1",
      ],
      options.cwd,
    );
    if (result.status === "Succeeded" && result.success === true) return result;
    if (
      result.done === true ||
      ["Failed", "Canceled", "SucceededPartial"].includes(String(result.status))
    ) {
      throw new JobFailedError(jobId, result, deploymentDiagnostics(result));
    }
    await new Promise((accept) => setTimeout(accept, 1000));
  }
  throw new SfciError(
    `Salesforce job ${jobId} is still running.`,
    "Run sfci resume --target <environment> to inspect and finish recording this operation.",
    "PENDING",
  );
}

export function deploymentDiagnostics(result: Record<string, unknown>): string {
  const details = record(result.details);
  const tests = record(details.runTestResult);
  const errors: string[] = [];
  for (const failure of records(details.componentFailures)) {
    const problem = text(failure.problem);
    if (!problem) continue;
    const component = [text(failure.componentType), text(failure.fullName)]
      .filter(Boolean)
      .join(" ");
    const file = text(failure.fileName);
    const line = position(failure.lineNumber);
    const column = position(failure.columnNumber);
    const location = file
      ? ` (${file}${line ? `:${line}${column ? `:${column}` : ""}` : ""})`
      : "";
    errors.push(`${component || "Metadata"}${location}: ${problem}`);
  }
  for (const failure of records(tests.failures)) {
    const message = text(failure.message);
    if (!message) continue;
    const method = [text(failure.name), text(failure.methodName)]
      .filter(Boolean)
      .join(".");
    errors.push(`Apex ${method || "test"}: ${message}`);
  }
  for (const warning of records(tests.codeCoverageWarnings)) {
    const message = text(warning.message);
    if (message)
      errors.push(
        `Coverage${warning.name ? ` ${text(warning.name)}` : ""}: ${message}`,
      );
  }
  if (!errors.length && typeof result.errorMessage === "string")
    errors.push(text(result.errorMessage));
  const unique = [...new Set(errors)];
  const visible = unique.slice(0, 8);
  if (unique.length > visible.length)
    visible.push(
      `… ${unique.length - visible.length} more error(s). Inspect Salesforce Deployment Status for the full report.`,
    );
  return visible.join("\n");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return (Array.isArray(value) ? value : [value])
    .map(record)
    .filter((entry) => Object.keys(entry).length > 0);
}

function text(value: unknown): string {
  if (typeof value !== "string") return "";
  // Redact before shortening: truncation must not expose a fragment of a secret.
  const safe = redact(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return safe.length > 300 ? `${safe.slice(0, 299)}…` : safe;
}

function position(value: unknown): string {
  return (typeof value === "number" || typeof value === "string") &&
    /^\d+$/.test(String(value)) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
    ? String(value)
    : "";
}
export function jobId(result: Record<string, unknown>): string {
  if (
    typeof result.id !== "string" ||
    !/^0Af[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(result.id)
  )
    throw new SfciError(
      "Salesforce did not return a valid deployment ID.",
      "Inspect Deployment Status before retrying.",
      "SALESFORCE",
    );
  return result.id;
}
