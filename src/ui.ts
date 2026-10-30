import { inspect } from "node:util";

export interface OutputOptions {
  json: boolean;
  verbose: boolean;
}

export class CliError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(message: string, hint?: string, code = "USAGE") {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.hint = hint;
  }
}

export function interactive(options: OutputOptions): boolean {
  return Boolean(
    process.stdin.isTTY &&
      process.stderr.isTTY &&
      !process.env.CI &&
      !options.json,
  );
}

export async function confirmAction(
  message: string,
  yes: boolean,
  options: OutputOptions,
): Promise<void> {
  if (yes) return;
  if (!interactive(options)) {
    throw new CliError(
      "Confirmation required.",
      "Review the target and rerun with --yes.",
    );
  }
  const prompts = await import("@clack/prompts");
  const answer = await prompts.confirm({
    message,
    initialValue: false,
    output: process.stderr,
  });
  if (prompts.isCancel(answer) || !answer)
    throw new CliError("Cancelled.", undefined, "CANCELLED");
}

export async function withProgress<T>(
  message: string,
  options: OutputOptions,
  operation: () => Promise<T>,
): Promise<T> {
  if (!interactive(options)) return operation();
  const { spinner } = await import("@clack/prompts");
  const progress = spinner({ output: process.stderr });
  progress.start(message);
  try {
    const result = await operation();
    progress.stop(message);
    return result;
  } catch (error) {
    progress.stop("Stopped.");
    throw error;
  }
}

export function output(
  command: string,
  result: unknown,
  options: OutputOptions,
): void {
  result = redactResult(result, makeRedactor());
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, command, result }, null, 2)}\n`,
    );
    return;
  }
  const value = asRecord(result);
  if (command === "init") {
    process.stdout.write("sfci is ready.\n");
    for (const file of asArray(value.files))
      process.stdout.write(`  Created ${String(file)}\n`);
    for (const note of asArray(value.notes))
      process.stdout.write(`  ${String(note)}\n`);
    process.stdout.write("\nNext: connect your orgs, then run sfci doctor.\n");
  } else if (command === "doctor") {
    for (const check of asArray(value.checks)) {
      const item = asRecord(check);
      process.stdout.write(
        `${item.status === "passed" ? "✓" : "✗"} ${String(item.name)}: ${String(item.detail)}\n`,
      );
    }
  } else if (command === "plan") {
    printPlan(value);
  } else if (command === "check") {
    const plan = asRecord(value.plan);
    if (Object.keys(plan).length) printPlan(plan);
    process.stdout.write(
      `${plan.empty ? "No metadata change to validate." : "Validation succeeded."}\n`,
    );
    const validation = asRecord(value.validation);
    if (validation.jobId)
      process.stdout.write(`  Salesforce job ${String(validation.jobId)}\n`);
  } else if (command === "release") {
    process.stdout.write(
      `Release frozen${value.commit ? ` at ${short(value.commit)}` : ""}.\n`,
    );
    if (value.path) process.stdout.write(`  ${String(value.path)}\n`);
  } else if (command === "baseline") {
    process.stdout.write(
      `Baseline recorded${value.target ? ` for ${String(value.target)}` : ""}${value.commit ? ` at ${short(value.commit)}` : ""}.\n`,
    );
    if (value.tag) process.stdout.write(`  ${String(value.tag)}\n`);
  } else if (command === "deploy" || command === "resume") {
    process.stdout.write(
      `${command === "resume" ? "Operation reconciled" : "Deployment succeeded"}${value.target ? ` for ${String(value.target)}` : ""}.\n`,
    );
    if (value.commit) process.stdout.write(`  Commit ${short(value.commit)}\n`);
    if (value.jobId)
      process.stdout.write(`  Salesforce job ${String(value.jobId)}\n`);
    if (value.tag) process.stdout.write(`  Receipt ${String(value.tag)}\n`);
  } else if (command === "status") {
    printStatus(result);
  }
  if (options.verbose)
    process.stderr.write(
      `${inspect(result, { depth: 5, colors: Boolean(process.stderr.isTTY) })}\n`,
    );
}

function printPlan(plan: Record<string, unknown>): void {
  process.stdout.write(
    `Plan ${String(plan.id ?? "")}${plan.target ? ` · ${String(plan.target)}` : ""}\n`,
  );
  process.stdout.write(`  ${short(plan.from)} → ${short(plan.to)}\n`);
  process.stdout.write(
    `  ${plan.mode === "full" ? "Full configured source scope" : `${String(plan.components ?? 0)} changed metadata component(s)`}, ${asArray(plan.destructive).length} deletion(s)\n`,
  );
  if (plan.path) process.stdout.write(`  ${String(plan.path)}\n`);
}

function printStatus(result: unknown): void {
  const value = asRecord(result);
  const rows = Array.isArray(result)
    ? result
    : Array.isArray(value.environments)
      ? value.environments
      : [value];
  for (const row of rows) {
    const item = asRecord(row);
    const receipt = asRecord(item.receipt ?? item.baseline);
    const target =
      item.target ?? item.environment ?? item.name ?? "Environment";
    process.stdout.write(
      `${String(target)} · ${receipt.commit ? short(receipt.commit) : item.commit ? short(item.commit) : "no baseline"}\n`,
    );
    if (item.pending)
      process.stdout.write(
        "  An operation needs attention. Run sfci resume for this target.\n",
      );
  }
}

export function reportError(error: unknown, options: OutputOptions): void {
  const record = asRecord(error);
  const message = redact(
    error instanceof Error ? error.message : String(error),
  );
  const code = typeof record.code === "string" ? record.code : "ERROR";
  const hint =
    typeof record.hint === "string" ? redact(record.hint) : undefined;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, error: { code, message, ...(hint ? { hint } : {}) } }, null, 2)}\n`,
    );
  } else {
    process.stderr.write(`${message}\n${hint ? `\n${hint}\n` : ""}`);
  }
  if (options.verbose && error instanceof Error && error.stack)
    process.stderr.write(`${redact(error.stack)}\n`);
}

export function redact(value: string): string {
  return makeRedactor()(value);
}

function makeRedactor(): (value: string) => string {
  const secrets = Object.entries(process.env)
    .filter(
      ([name, secret]) =>
        secret &&
        secret.length >= 8 &&
        /TOKEN|SECRET|PASSWORD|AUTH_URL|JWT|PRIVATE_KEY/i.test(name),
    )
    .map(([, secret]) => secret!);
  return (value) => {
    let safe = value
      .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
      .replace(/force:\/\/[^\s]+/gi, "[REDACTED Salesforce authorization URL]");
    for (const secret of secrets) safe = safe.replaceAll(secret, "[REDACTED]");
    return safe;
  };
}

function redactResult(
  value: unknown,
  redactText: (value: string) => string,
): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value))
    return value.map((item) => redactResult(item, redactText));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactResult(item, redactText),
      ]),
    );
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function short(value: unknown): string {
  return String(value ?? "?").slice(0, 12);
}
