import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { git } from "./process.js";
import { SfciError, type Receipt } from "./types.js";

export const hash = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function json<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    throw new SfciError(
      `Cannot read ${file}.`,
      "Use an existing sfci plan or operation file.",
      "ARTIFACT",
    );
  }
}
export async function save(file: string, value: unknown): Promise<void> {
  const { dirname } = await import("node:path");
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, file);
}
export async function root(cwd: string): Promise<string> {
  return git(cwd, "rev-parse", "--show-toplevel");
}
export async function commit(cwd: string, ref: string): Promise<string> {
  if (ref.startsWith("-") || /[\s\0]/.test(ref))
    throw new SfciError("Invalid Git revision.", undefined, "GIT");
  return git(cwd, "rev-parse", "--verify", `${ref}^{commit}`);
}
export async function refresh(cwd: string, trunk: string): Promise<void> {
  const remotes = (await git(cwd, "remote")).split("\n");
  if (remotes.includes("origin"))
    await git(
      cwd,
      "fetch",
      "origin",
      "--tags",
      `+refs/heads/${trunk}:refs/remotes/origin/${trunk}`,
    );
}
export async function clean(cwd: string): Promise<void> {
  const status = await git(
    cwd,
    "status",
    "--porcelain",
    "--untracked-files=normal",
  );
  if (status)
    throw new SfciError(
      "The working tree has uncommitted files.",
      "Commit your changes, or stash them, before preparing a deployment.",
      "DIRTY_TREE",
    );
}
export async function receipts(
  cwd: string,
  target: string,
): Promise<Receipt[]> {
  const tags = (
    await git(
      cwd,
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/tags/sfci/${target}/`,
    )
  )
    .split("\n")
    .filter(Boolean);
  const receipts: Receipt[] = [];
  for (const tag of tags) {
    const contents = await git(
      cwd,
      "for-each-ref",
      "--format=%(contents)",
      `refs/tags/${tag}`,
    );
    let receipt: Receipt;
    try {
      receipt = JSON.parse(contents) as Receipt;
    } catch {
      throw new SfciError(
        `Invalid deployment receipt ${tag}.`,
        "Inspect the tag; sfci will not guess the baseline.",
        "BASELINE",
      );
    }
    if (
      receipt.schemaVersion !== 1 ||
      receipt.target !== target ||
      receipt.status !== "success" ||
      receipt.tag !== tag ||
      !["baseline", "deployment"].includes(receipt.kind) ||
      typeof receipt.orgId !== "string" ||
      !/^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(receipt.orgId) ||
      !Number.isSafeInteger(receipt.sequence) ||
      receipt.sequence < 1 ||
      !Number.isFinite(Date.parse(receipt.completedAt)) ||
      receipt.commit !== (await commit(cwd, tag))
    ) {
      throw new SfciError(
        `Deployment receipt ${tag} is inconsistent.`,
        undefined,
        "BASELINE",
      );
    }
    receipts.push(receipt);
  }
  receipts.sort((a, b) => b.sequence - a.sequence);
  return receipts;
}
export async function baseline(
  cwd: string,
  target: string,
): Promise<Receipt | null> {
  const history = await receipts(cwd, target);
  const latest = history[0];
  if (!latest) return null;
  if (history[1]?.sequence === latest.sequence)
    throw new SfciError(
      `Conflicting deployment receipts for ${target}.`,
      "Reconcile the org and receipt history before continuing.",
      "BASELINE",
    );
  return latest;
}
export async function requireBaseline(
  cwd: string,
  target: string,
): Promise<Receipt> {
  const result = await baseline(cwd, target);
  if (!result)
    throw new SfciError(
      `No baseline recorded for ${target}.`,
      `Run sfci baseline set --target ${target} --commit <known-org-commit>.`,
      "BASELINE",
    );
  return result;
}
export async function writeReceipt(
  cwd: string,
  receipt: Receipt,
  push: boolean,
): Promise<void> {
  const existing = await git(cwd, "tag", "--list", receipt.tag);
  if (existing) {
    const contents = await git(
      cwd,
      "for-each-ref",
      "--format=%(contents)",
      `refs/tags/${receipt.tag}`,
    );
    if (canonical(JSON.parse(contents)) !== canonical(receipt))
      throw new SfciError(
        `Receipt ${receipt.tag} already exists with different contents.`,
        undefined,
        "BASELINE",
      );
  } else {
    await git(
      cwd,
      "-c",
      "user.name=sfci",
      "-c",
      "user.email=sfci@users.noreply.github.com",
      "tag",
      "--annotate",
      receipt.tag,
      receipt.commit,
      "--message",
      JSON.stringify(receipt),
    );
  }
  if (push) await git(cwd, "push", "origin", `refs/tags/${receipt.tag}`);
}
export async function locked<T>(
  cwd: string,
  orgId: string,
  task: () => Promise<T>,
): Promise<T> {
  const path = resolve(cwd, ".sfci", "locks", orgId);
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    await mkdir(path);
  } catch {
    throw new SfciError(
      "Another sfci process holds this org lock.",
      "Wait for it to finish. After a crashed process, inspect Salesforce Deployment Status before removing the .sfci/locks directory.",
      "LOCKED",
    );
  }
  try {
    return await task();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
