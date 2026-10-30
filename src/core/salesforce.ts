import {
  JobFailedError,
  SfciError,
  type Options,
  type Plan,
  type Runtime,
} from "./types.js";
import { defaultRuntime } from "./process.js";

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
      "Authenticate with sf org login web --alias <alias>, then verify access to the Organization object.",
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
      throw new JobFailedError(jobId, result);
    }
    await new Promise((accept) => setTimeout(accept, 1000));
  }
  throw new SfciError(
    `Salesforce job ${jobId} is still running.`,
    "Run sfci resume --target <environment> to inspect and finish recording this operation.",
    "PENDING",
  );
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
