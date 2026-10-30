import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  applyPlan,
  createPlan,
  createRelease,
  deploy,
  loadPlan,
  readConfig,
  resume,
  setBaseline,
  status,
  validatePlan,
  type Runtime,
} from "../src/core/index.js";

class FakeSalesforce implements Runtime {
  calls: string[][] = [];
  fail = false;
  disconnect = false;
  rollback = false;
  async sf(args: string[]): Promise<Record<string, unknown>> {
    this.calls.push(args);
    const org = args[args.indexOf("--target-org") + 1];
    if (args[0] === "data")
      return {
        records: [
          {
            Id: org === "prod" ? "00D000000000002AAA" : "00D000000000001AAA",
            IsSandbox: org !== "prod",
            OrganizationType: "Enterprise Edition",
          },
        ],
      };
    if (args.includes("report")) {
      if (this.disconnect) throw new Error("Connection interrupted");
      return this.fail
        ? {
            status: "Failed",
            success: false,
            done: true,
            rollbackOnError: this.rollback,
          }
        : { status: "Succeeded", success: true, done: true };
    }
    return { id: "0Af000000000001AAA", status: "Pending", done: false };
  }
}
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "sfci-core-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const put = async (name: string, content: string) => {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), content);
  };
  await put(".gitignore", ".sfci/\n");
  await put(
    "sfci.yml",
    "trunk: main\nenvironments:\n  uat:\n    org: uat\n  prod:\n    org: prod\n    promoteFrom: uat\n",
  );
  await put(
    "sfdx-project.json",
    JSON.stringify({
      packageDirectories: [{ path: "force-app", default: true }],
      sourceApiVersion: "67.0",
    }),
  );
  await put(
    "force-app/main/default/classes/Example.cls",
    "public class Example { public static Integer value() { return 1; } }",
  );
  await put(
    "force-app/main/default/classes/Example.cls-meta.xml",
    '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>67.0</apiVersion><status>Active</status></ApexClass>',
  );
  git("add", ".");
  git("commit", "-m", "Baseline");
  const first = git("rev-parse", "HEAD");
  const runtime = new FakeSalesforce();
  await setBaseline({
    cwd,
    runtime,
    target: "uat",
    commit: first,
    push: false,
  });
  await setBaseline({
    cwd,
    runtime,
    target: "prod",
    commit: first,
    push: false,
  });
  const change = async (value: number) => {
    await put(
      "force-app/main/default/classes/Example.cls",
      `public class Example { public static Integer value() { return ${value}; } }`,
    );
    git("add", ".");
    git("commit", "-m", `Change ${value}`);
    return git("rev-parse", "HEAD");
  };
  return {
    cwd,
    runtime,
    git,
    put,
    first,
    change,
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

test("a real Git Delta plan spans every commit since the successful baseline and snapshots source", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.change(2);
  const head = await f.change(3);
  const plan = await createPlan({
    cwd: f.cwd,
    target: "uat",
    runtime: f.runtime,
  });
  assert.equal(plan.from, f.first);
  assert.equal(plan.to, head);
  assert.equal(plan.components, 1);
  assert.equal(plan.empty, false);
  assert.equal(plan.production, false);
  assert.match(
    await readFile(
      join(
        dirname(plan.path),
        "content/source/force-app/main/default/classes/Example.cls",
      ),
      "utf8",
    ),
    /return 3/,
  );
  const checked = await validatePlan({
    cwd: f.cwd,
    runtime: f.runtime,
    planPath: plan.path,
  });
  assert.equal(checked.status, "Succeeded");
  assert.equal(checked.quickDeploy, false);
  const receipt = await applyPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    planPath: plan.path,
    push: false,
  });
  assert.equal(receipt.commit, head);
  assert.equal(receipt.sequence, 2);
  assert.equal(
    (await status({ cwd: f.cwd, target: "uat" })).environments[0]?.receipt
      ?.commit,
    head,
  );
});
test("plan bytes and target mismatches fail before a Salesforce mutation", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.change(2);
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
  });
  await assert.rejects(
    () =>
      applyPlan({
        cwd: f.cwd,
        runtime: f.runtime,
        planPath: plan.path,
        target: "prod",
        push: false,
      }),
    /targets uat/,
  );
  await writeFile(
    join(
      dirname(plan.path),
      "content/source/force-app/main/default/classes/Example.cls",
    ),
    "tampered",
  );
  await assert.rejects(() => loadPlan(plan.path), /files have changed/);
  assert.equal(
    f.runtime.calls.filter((args) => args[0] === "project").length,
    0,
  );
});
test("a stale baseline invalidates a prepared plan", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const head = await f.change(2);
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
  });
  await setBaseline({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
    commit: head,
    push: false,
  });
  await assert.rejects(
    () =>
      applyPlan({
        cwd: f.cwd,
        runtime: f.runtime,
        planPath: plan.path,
        push: false,
      }),
    /baseline changed/,
  );
});
test("production promotion uses its own cumulative baseline and a frozen deployed UAT receipt", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const second = await f.change(2);
  await deploy({ cwd: f.cwd, runtime: f.runtime, target: "uat", push: false });
  const release = await createRelease({
    cwd: f.cwd,
    runtime: f.runtime,
    from: "uat",
    output: ".sfci/release.json",
  });
  assert.equal(release.commit, second);
  await f.change(3);
  const result = await deploy({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "prod",
    releasePath: ".sfci/release.json",
    push: false,
  });
  assert.equal(result.commit, second);
  assert.ok(f.runtime.calls.some((args) => args[2] === "validate"));
  assert.ok(f.runtime.calls.some((args) => args[2] === "quick"));
  const plan = await loadPlan(
    join(f.cwd, ".sfci/plans", result.planId!, "plan.json"),
  );
  assert.equal(plan.from, f.first);
  assert.equal(plan.to, second);
});
test("deployment failure never advances the baseline", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.change(2);
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
  });
  f.runtime.fail = true;
  await assert.rejects(
    () =>
      applyPlan({
        cwd: f.cwd,
        runtime: f.runtime,
        planPath: plan.path,
        push: false,
      }),
    /status Failed/,
  );
  assert.equal(
    (await status({ cwd: f.cwd, target: "uat" })).environments[0]?.receipt
      ?.commit,
    f.first,
  );
});
test("configuration rejects unknown fields and promotion cycles", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put(
    "sfci.yml",
    "trunk: main\nenvironments:\n  uat:\n    org: uat\n    promoteFrom: prod\n  prod:\n    org: prod\n    promoteFrom: uat\n",
  );
  await assert.rejects(() => readConfig(f.cwd), /cycle/);
  await f.put(
    "sfci.yml",
    "trunk: main\nenvironments:\n  uat:\n    org: --target-org=other\n",
  );
  await assert.rejects(() => readConfig(f.cwd), /Invalid environment/);
});
test("empty metadata deltas record the known source commit without submitting a Salesforce job", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put("README.md", "Documentation only");
  f.git("add", ".");
  f.git("commit", "-m", "Docs");
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
  });
  assert.equal(plan.empty, true);
  const receipt = await applyPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    planPath: plan.path,
    push: false,
  });
  assert.equal(receipt.jobId, null);
  assert.equal(receipt.commit, f.git("rev-parse", "HEAD"));
  assert.equal(
    f.runtime.calls.filter((args) => args[0] === "project").length,
    0,
  );
});
test("resume finishes an accepted job instead of submitting a second deployment", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.change(2);
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
  });
  f.runtime.disconnect = true;
  await assert.rejects(
    () =>
      applyPlan({
        cwd: f.cwd,
        runtime: f.runtime,
        planPath: plan.path,
        push: false,
      }),
    /Connection interrupted/,
  );
  assert.equal(
    (await status({ cwd: f.cwd, target: "uat" })).environments[0]?.pending
      ?.phase,
    "running",
  );
  f.runtime.disconnect = false;
  const receipt = await resume({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
    push: false,
  });
  assert.equal(receipt.planId, plan.id);
  assert.equal(
    f.runtime.calls.filter(
      (args) => args[0] === "project" && args[2] === "start",
    ).length,
    1,
  );
});
test("receipt publication can be retried without redeploying a successful job", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.change(2);
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
  });
  await assert.rejects(
    () =>
      applyPlan({
        cwd: f.cwd,
        runtime: f.runtime,
        planPath: plan.path,
        push: true,
      }),
    /receipt could not be published/,
  );
  const pending = (await status({ cwd: f.cwd, target: "uat" })).environments[0]
    ?.pending;
  assert.equal(pending?.phase, "succeeded");
  assert.ok(pending?.receipt);
  const receipt = await resume({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
    push: false,
  });
  assert.equal(receipt.tag, pending?.receipt?.tag);
  assert.equal(
    f.runtime.calls.filter(
      (args) => args[0] === "project" && args[2] === "start",
    ).length,
    1,
  );
});
test("metadata deletion requires an explicit opt-in and keeps constructive/deletion manifests together", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.git(
    "rm",
    "force-app/main/default/classes/Example.cls",
    "force-app/main/default/classes/Example.cls-meta.xml",
  );
  f.git("commit", "-m", "Remove Apex");
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
  });
  assert.deepEqual(plan.destructive, ["ApexClass:Example"]);
  await assert.rejects(
    () =>
      applyPlan({
        cwd: f.cwd,
        runtime: f.runtime,
        planPath: plan.path,
        push: false,
      }),
    /metadata deletions/,
  );
  await applyPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    planPath: plan.path,
    push: false,
    allowDestructive: true,
  });
  assert.ok(
    f.runtime.calls
      .find((args) => args[0] === "project" && args[2] === "start")
      ?.includes("--post-destructive-changes"),
  );
});
test("a confirmed rollback clears the pending operation while leaving the baseline unchanged", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.change(2);
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
  });
  f.runtime.fail = true;
  f.runtime.rollback = true;
  await assert.rejects(
    () =>
      applyPlan({
        cwd: f.cwd,
        runtime: f.runtime,
        planPath: plan.path,
        push: false,
      }),
    /status Failed/,
  );
  const state = (await status({ cwd: f.cwd, target: "uat" })).environments[0];
  assert.equal(state?.pending, null);
  assert.equal(state?.receipt?.commit, f.first);
});
test("obsolete main deployments and stale feature candidates are rejected", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.change(2);
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
  });
  await f.change(3);
  await assert.rejects(
    () =>
      applyPlan({
        cwd: f.cwd,
        runtime: f.runtime,
        planPath: plan.path,
        push: false,
      }),
    /no longer the current trunk/,
  );
  f.git("switch", "-c", "old-feature", f.first);
  await f.put("old.txt", "old");
  f.git("add", ".");
  f.git("commit", "-m", "Old feature");
  await assert.rejects(
    () => createPlan({ cwd: f.cwd, runtime: f.runtime, target: "uat" }),
    /behind the current trunk/,
  );
});
test("a production plan cannot bypass the required source deployment proof", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.change(2);
  await assert.rejects(
    () => createPlan({ cwd: f.cwd, runtime: f.runtime, target: "prod" }),
    /no successful deployment receipt/,
  );
});
test("only a fully valid cached validation can be reused", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.change(2);
  await deploy({ cwd: f.cwd, runtime: f.runtime, target: "uat", push: false });
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "prod",
  });
  const validated = await validatePlan({
    cwd: f.cwd,
    runtime: f.runtime,
    planPath: plan.path,
  });
  const cache = join(dirname(plan.path), "validation.json");
  const submissions = () =>
    f.runtime.calls.filter(
      (args) => args[0] === "project" && args[2] === "validate",
    ).length;
  const beforeReuse = submissions();
  assert.deepEqual(
    await validatePlan({ cwd: f.cwd, runtime: f.runtime, planPath: plan.path }),
    validated,
  );
  assert.equal(submissions(), beforeReuse);

  const invalid: unknown[] = [
    null,
    [],
    { ...validated, schemaVersion: 2 },
    { ...validated, status: "Failed" },
    { ...validated, status: "Empty" },
    { ...validated, quickDeploy: false },
    { ...validated, quickDeploy: "true" },
    { ...validated, jobId: null },
    { ...validated, jobId: "arbitrary-job" },
    { ...validated, planId: "another-plan" },
    { ...validated, orgId: "00D000000000999AAA" },
    { ...validated, baselineTag: "another-baseline" },
    { ...validated, completedAt: "not-a-date" },
    { ...validated, completedAt: new Date(Date.now() + 60_000).toISOString() },
    {
      ...validated,
      completedAt: new Date(
        Date.now() - 10 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    },
  ];
  for (const corrupted of invalid) {
    const before = submissions();
    await writeFile(cache, JSON.stringify(corrupted));
    const result = await validatePlan({
      cwd: f.cwd,
      runtime: f.runtime,
      planPath: plan.path,
    });
    assert.equal(result.status, "Succeeded");
    assert.equal(result.quickDeploy, true);
    assert.equal(result.jobId, "0Af000000000001AAA");
    assert.equal(
      submissions(),
      before + 1,
      `Cache should be rejected: ${JSON.stringify(corrupted)}`,
    );
  }
});
test("an empty plan cannot reuse a cache claiming a Salesforce job or production quick deploy", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
  });
  const valid = await validatePlan({
    cwd: f.cwd,
    runtime: f.runtime,
    planPath: plan.path,
  });
  await writeFile(
    join(dirname(plan.path), "validation.json"),
    JSON.stringify({
      ...valid,
      jobId: "0Af000000000001AAA",
      quickDeploy: true,
    }),
  );
  const result = await validatePlan({
    cwd: f.cwd,
    runtime: f.runtime,
    planPath: plan.path,
  });
  assert.equal(result.status, "Empty");
  assert.equal(result.jobId, null);
  assert.equal(result.quickDeploy, false);
  assert.equal(
    f.runtime.calls.filter((args) => args[0] === "project").length,
    0,
  );
});

test("widening .forceignore requires full mode to include unchanged metadata", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put(".forceignore", "**/classes/Example.*\n");
  f.git("add", ".");
  f.git("commit", "-m", "Narrow managed scope");
  await setBaseline({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
    commit: "HEAD",
    push: false,
  });
  await f.put(".forceignore", "");
  f.git("add", ".");
  f.git("commit", "-m", "Include unchanged Apex class");

  await assert.rejects(
    () => createPlan({ cwd: f.cwd, runtime: f.runtime, target: "uat" }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "SCOPE_CHANGED" &&
      "hint" in error &&
      String(error.hint).includes("--mode full"),
  );
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
    mode: "full",
  });
  assert.equal(plan.empty, false);
  assert.equal(
    plan.components,
    0,
    "The newly included class is unchanged, so Git Delta alone would miss it",
  );
  await applyPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    planPath: plan.path,
    push: false,
  });
  const submission = f.runtime.calls.find(
    (args) => args[0] === "project" && args[2] === "start",
  );
  assert.ok(submission?.includes("--source-dir"));
  assert.ok(plan.files["source/force-app/main/default/classes/Example.cls"]);
});

test("package-directory and API-version changes also require full mode", async (t) => {
  for (const change of ["directories", "apiVersion"] as const) {
    await t.test(change, async (t) => {
      const f = await fixture();
      t.after(f.cleanup);
      await f.put(
        "sfdx-project.json",
        JSON.stringify({
          packageDirectories: [
            {
              path: change === "directories" ? "." : "force-app",
              default: true,
            },
          ],
          sourceApiVersion: change === "apiVersion" ? "66.0" : "67.0",
        }),
      );
      f.git("add", ".");
      f.git("commit", "-m", "Change deployment scope");
      await assert.rejects(
        () => createPlan({ cwd: f.cwd, runtime: f.runtime, target: "uat" }),
        /Managed scope changed/,
      );
      assert.equal(
        (
          await createPlan({
            cwd: f.cwd,
            runtime: f.runtime,
            target: "uat",
            mode: "full",
          })
        ).mode,
        "full",
      );
    });
  }
});
