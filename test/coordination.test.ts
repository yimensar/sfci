import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkpoint,
  pendingRef,
  releaseClaim,
  remoteClaim,
  type Checkpoint,
} from "../src/core/coordination.js";

test("Git atomically arbitrates separate runners and refuses stale checkpoint updates or deletion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sfci-coordination-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const first = join(directory, "first"),
    second = join(directory, "second"),
    origin = join(directory, "origin.git");
  run(directory, "init", "--bare", origin);
  run(directory, "clone", origin, first);
  run(first, "config", "user.name", "Fixture");
  run(first, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(first, "README.md"), "fixture");
  run(first, "add", ".");
  run(first, "commit", "-m", "Initial");
  run(first, "push", "origin", "HEAD:main");
  run(directory, "clone", "--branch", "main", origin, second);
  const value: Checkpoint = {
    schemaVersion: 1,
    target: "uat",
    orgId: "00D000000000001AAA",
    commit: run(first, "rev-parse", "HEAD"),
    operation: null,
  };
  const results = await Promise.allSettled([
    checkpoint(first, value, null),
    checkpoint(second, value, null),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const claim = await remoteClaim(first, value.orgId);
  assert.ok(claim);
  run(first, "config", "push.followTags", "true");
  const updated = await checkpoint(
    first,
    { ...value, target: "production" },
    claim,
  );
  await assert.rejects(() => checkpoint(second, value, claim), /checkpoint/);
  await assert.rejects(() => releaseClaim(second, claim), /Git could not push/);
  assert.equal((await remoteClaim(second, value.orgId))?.oid, updated.oid);
  assert.equal(
    run(first, "ls-remote", "origin", "refs/tags/sfci-internal/*"),
    "",
  );
  assert.equal(pendingRef(value.orgId), pendingRef(value.orgId.slice(0, 15)));
  await releaseClaim(first, updated);
  assert.equal(await remoteClaim(second, value.orgId), null);
});
