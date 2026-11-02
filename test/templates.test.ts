import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import {
  bitbucketPipeline,
  githubWorkflow,
} from "../src/commands/templates.js";
import { parseConfig } from "../src/core/config.js";

const config = parseConfig({
  trunk: "main",
  environments: {
    integration: { org: "int", type: "sandbox" },
    staging: { org: "staging", type: "sandbox", promoteFrom: "integration" },
    live: { org: "prod", type: "production", promoteFrom: "staging" },
  },
});

test("Bitbucket generates the configured integration/staging/live promotion path with JWT scopes", () => {
  const source = bitbucketPipeline(config),
    yaml = parse(source);
  assert.doesNotMatch(source, /SF_AUTH_URL|sfdx-url|org login web|sfci-uat/);
  assert.equal(
    yaml.pipelines["pull-requests"]["**"][0].step.environment,
    "integration",
  );
  assert.equal(yaml.pipelines.branches.main.length, 1);
  assert.equal(yaml.pipelines.branches.main[0].step.deployment, "integration");
  for (const [name, from] of [
    ["staging", "integration"],
    ["live", "staging"],
  ]) {
    const [freeze, deploy] = yaml.pipelines.custom[`promote-${name}`];
    assert.equal(freeze.step.environment, from);
    assert.ok(
      freeze.step.script.includes(
        `sfci release --from ${from} --output .sfci/release.json`,
      ),
    );
    assert.equal(deploy.step.deployment, name);
    assert.equal(deploy.step.trigger, "manual");
    assert.ok(deploy.step.script.includes(`sfci auth --target ${name}`));
    assert.equal(deploy.step.artifacts[0]["capture-on"], "always");
    assert.deepEqual(deploy.step.artifacts[0].paths, [
      ".sfci/plans/**",
      ".sfci/operations/**",
    ]);
  }
});

test("one sandbox needs no fictional production environment", () => {
  const yaml = parse(
    bitbucketPipeline(
      parseConfig({
        trunk: "trunk",
        environments: { qa: { org: "qa", type: "sandbox" } },
      }),
    ),
  );
  assert.equal(yaml.pipelines.branches.trunk[0].step.deployment, "qa");
  assert.equal(yaml.pipelines.custom, undefined);
});

test("a direct production target is manually triggered, not deployed on each push", () => {
  const yaml = parse(
    bitbucketPipeline(
      parseConfig({
        trunk: "main",
        environments: { live: { org: "prod", type: "production" } },
      }),
    ),
  );
  assert.equal(yaml.pipelines.branches, undefined);
  assert.equal(yaml.pipelines.custom["deploy-live"][0].step.deployment, "live");
});

test("GitHub uses named targets, promotion proofs, scoped JWT inputs and exact recovery artifacts", () => {
  const source = githubWorkflow(config),
    yaml = parse(source);
  assert.deepEqual(yaml.on.workflow_dispatch.inputs.target.options, [
    "integration",
    "staging",
    "live",
  ]);
  assert.equal(yaml.jobs["freeze-live"].environment, "staging");
  assert.equal(yaml.jobs["deploy-live"].needs, "freeze-live");
  const recovery = yaml.jobs.recover;
  assert.equal(recovery.permissions.actions, "read");
  assert.equal(recovery.permissions.contents, "write");
  assert.equal(recovery.concurrency["cancel-in-progress"], false);
  const restore = recovery.steps.find(
    (step: { name?: string }) =>
      step.name === "Restore that deployment checkpoint",
  );
  assert.equal(restore.with["run-id"], "${{ inputs.recovery_run }}");
  assert.equal(restore.with.name, "sfci-${{ inputs.target }}");
  assert.equal(restore.with.path, ".sfci");
  assert.ok(
    recovery.steps.some(
      (step: { run?: string }) =>
        step.run === 'sfci resume --target "$TARGET" --yes --push',
    ),
  );
  for (const job of Object.values(yaml.jobs) as {
    steps: {
      run?: string;
      env?: Record<string, string>;
      uses?: string;
      with?: { path: string };
    }[];
  }[]) {
    const auth = job.steps.find((step) => step.run?.startsWith("sfci auth"));
    assert.ok(auth);
    for (const key of [
      "SF_CLIENT_ID",
      "SF_USERNAME",
      "SF_INSTANCE_URL",
      "SF_JWT_KEY_B64",
    ])
      assert.equal(auth.env?.[key], `\${{ secrets.${key} }}`);
    const upload = job.steps.find(
      (step) => step.uses === "actions/upload-artifact@v4",
    );
    assert.doesNotMatch(
      upload?.with?.path ?? "",
      /locks|work|tmp|\.sfci\/\*\*/,
    );
  }
});

test("environment types and promotion cycles are validated before generation", () => {
  assert.throws(
    () =>
      parseConfig({
        trunk: "main",
        environments: { x: { org: "x", type: "developer" } },
      }),
    /type/,
  );
  assert.throws(
    () =>
      parseConfig({
        trunk: "main",
        environments: {
          x: { org: "x", type: "sandbox", promoteFrom: "y" },
          y: { org: "y", type: "production", promoteFrom: "x" },
        },
      }),
    /cycle/,
  );
});
