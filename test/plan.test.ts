import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  createPlan,
  deploymentArgs,
  loadPlan,
  manifestMembers,
  withExecutionWorkspace,
} from "../src/core/plan.js";
import { setBaseline } from "../src/core/index.js";
import type { Runtime } from "../src/core/types.js";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "sfci-plan-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const put = async (path: string, value: string) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), value);
  };
  const apex = async (directory: string, name: string) => {
    await put(
      `${directory}/main/default/classes/${name}.cls`,
      `public class ${name} {}`,
    );
    await put(
      `${directory}/main/default/classes/${name}.cls-meta.xml`,
      '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>67.0</apiVersion><status>Active</status></ApexClass>',
    );
  };
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await put(".gitignore", ".sfci/\n");
  await put("sfci.yml", "trunk: main\nenvironments:\n  uat:\n    org: uat\n");
  await put(
    "sfdx-project.json",
    JSON.stringify({
      packageDirectories: [{ path: "force-app", default: true }],
      sourceApiVersion: "67.0",
    }),
  );
  const runtime: Runtime = {
    async sf(args) {
      assert.equal(
        args[0],
        "data",
        "Preparing a manifest must not launch Salesforce CLI",
      );
      return {
        records: [
          {
            Id: "00D000000000001AAA",
            IsSandbox: true,
            OrganizationType: "Enterprise Edition",
          },
        ],
      };
    },
  };
  return {
    cwd,
    git,
    put,
    apex,
    runtime,
    async baseline() {
      git("add", ".");
      git("commit", "-m", "Baseline");
      await setBaseline({
        cwd,
        runtime,
        target: "uat",
        commit: "HEAD",
        push: false,
      });
    },
    commit() {
      git("add", ".");
      git("commit", "-m", "Candidate");
    },
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

test("official manifest resolution handles XML attributes, entities and duplicate members", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "sfci-xml-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = join(directory, "package.xml");
  await writeFile(
    manifest,
    `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
  <types description="XML attributes are valid">
    <members>Sales/Revenue &amp; Margin</members>
    <members><![CDATA[Sales/Revenue > Costs]]></members>
    <name>Report</name>
  </types>
  <types><members>Example</members><members>Example</members><name>ApexClass</name></types>
  <version>67.0</version>
</Package>`,
  );
  assert.deepEqual(await manifestMembers(manifest), [
    "ApexClass:Example",
    "Report:Sales/Revenue & Margin",
    "Report:Sales/Revenue > Costs",
  ]);
  await writeFile(manifest, "<Package><types></Package>");
  await assert.rejects(() => manifestMembers(manifest), /Invalid manifest/);
});

test("full plans freeze the actual managed scope and reuse that manifest across workspaces", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.apex("force-app", "Unchanged");
  await f.apex("force-app", "Excluded");
  await f.apex("outside-scope", "Unmanaged");
  await f.put(".forceignore", "**/classes/Excluded.*\n");
  await f.baseline();
  await f.apex("force-app", "Added");
  f.commit();
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
    mode: "full",
  });
  assert.equal(
    plan.components,
    2,
    "Full scope includes unchanged managed metadata",
  );
  assert.equal(plan.empty, false);
  assert.ok(plan.files["full/package.xml"]);
  const prepared = join(dirname(plan.path), "content/full/package.xml");
  assert.deepEqual(await manifestMembers(prepared), [
    "ApexClass:Added",
    "ApexClass:Unchanged",
  ]);
  const bytes = await readFile(prepared, "utf8");
  assert.match(bytes, /<version>67\.0<\/version>/);
  const manifests: string[] = [];
  const offline: Runtime = {
    async sf() {
      throw new Error("Unexpected Salesforce CLI call");
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await withExecutionWorkspace(plan, { cwd: f.cwd }, async (workspace) => {
      const args = await deploymentArgs(plan, workspace, {
        cwd: f.cwd,
        runtime: offline,
      });
      const manifest = args[args.indexOf("--manifest") + 1]!;
      manifests.push(manifest);
      assert.equal(await readFile(manifest, "utf8"), bytes);
      assert.equal(args.includes("--source-dir"), false);
    });
  }
  assert.deepEqual(manifests, [prepared, prepared]);
  assert.equal((await loadPlan(plan.path)).id, plan.id);
  await writeFile(prepared, bytes.replace("Unchanged", "Tampered"));
  await assert.rejects(() => loadPlan(plan.path), /files have changed/);
});

test("a full plan with no managed components is empty", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.apex("force-app", "Excluded");
  await f.put(".forceignore", "**/classes/Excluded.*\n");
  await f.baseline();
  const plan = await createPlan({
    cwd: f.cwd,
    runtime: f.runtime,
    target: "uat",
    mode: "full",
  });
  assert.equal(plan.components, 0);
  assert.equal(plan.empty, true);
  assert.deepEqual(plan.destructive, []);
});
