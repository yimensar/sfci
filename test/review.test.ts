import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  createPlan,
  setBaseline,
  validatePlan,
  type Runtime,
} from "../src/core/index.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const coreUrl = new URL("../src/core/index.ts", import.meta.url).href;

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "sfci-review-"));
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
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await put(".gitignore", ".sfci/\n");
  await put(".forceignore", "**/classes/Ignored*\n");
  await put("sfci.yml", "trunk: main\nenvironments:\n  uat:\n    org: uat\n");
  await put(
    "sfdx-project.json",
    JSON.stringify({
      packageDirectories: [{ path: "force-app", default: true }],
      sourceApiVersion: "67.0",
    }),
  );
  for (const name of ["Included", "IgnoredChange", "IgnoredDelete"]) {
    await put(
      `force-app/main/default/classes/${name}.cls`,
      `public class ${name} {}`,
    );
    await put(
      `force-app/main/default/classes/${name}.cls-meta.xml`,
      '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>67.0</apiVersion><status>Active</status></ApexClass>',
    );
  }
  git("add", ".");
  git("commit", "-qm", "Initial");
  let orgId = "00D000000000001AAA";
  const runtime: Runtime = {
    sf: async () => ({ records: [{ Id: orgId, IsSandbox: true }] }),
  };
  await setBaseline({
    cwd,
    target: "uat",
    commit: "HEAD",
    runtime,
    push: false,
  });
  return {
    cwd,
    git,
    put,
    runtime,
    refreshOrg: () => {
      orgId = "00D000000000002AAA";
    },
    cleanup: () => rm(cwd, { recursive: true, force: true }),
  };
}

test("real Git Delta respects constructive and destructive ignores without polluting JSON stdout", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put(
    "force-app/main/default/classes/Included.cls",
    "public class Included { public Integer x; }",
  );
  await f.put(
    "force-app/main/default/classes/IgnoredChange.cls",
    "public class IgnoredChange { public Integer x; }",
  );
  f.git(
    "rm",
    "force-app/main/default/classes/IgnoredDelete.cls",
    "force-app/main/default/classes/IgnoredDelete.cls-meta.xml",
  );
  f.git("add", ".");
  f.git("commit", "-qm", "Changed and ignored metadata");
  const script = `const {createPlan}=await import(${JSON.stringify(coreUrl)});const runtime={sf:async()=>({records:[{Id:'00D000000000001AAA',IsSandbox:true}]})};const plan=await createPlan({cwd:${JSON.stringify(f.cwd)},target:'uat',runtime});process.stdout.write(JSON.stringify({components:plan.components,destructive:plan.destructive}));`;
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete environment.FORCE_COLOR;
  const scriptPath = join(f.cwd, ".sfci/review.mjs");
  await writeFile(scriptPath, script);
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: projectRoot,
    encoding: "utf8",
    env: environment,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    components: 1,
    destructive: [],
  });
});

test("an org refresh invalidates a prepared plan before any deployment", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put(
    "force-app/main/default/classes/Included.cls",
    "public class Included { public Integer x; }",
  );
  f.git("add", ".");
  f.git("commit", "-qm", "Change");
  const plan = await createPlan({
    cwd: f.cwd,
    target: "uat",
    runtime: f.runtime,
  });
  f.refreshOrg();
  await assert.rejects(
    () => validatePlan({ cwd: f.cwd, planPath: plan.path, runtime: f.runtime }),
    /org behind this alias changed/i,
  );
});

test("Git LFS pointers cannot be silently deployed as static resource content", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.put(
    "force-app/main/default/staticresources/Asset.resource",
    `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 4096\n`,
  );
  f.git("add", ".");
  f.git("commit", "-qm", "Resource stored in LFS");
  await assert.rejects(
    () => createPlan({ cwd: f.cwd, runtime: f.runtime, target: "uat" }),
    /Git LFS pointer/,
  );
});
