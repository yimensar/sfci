import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import {
  bitbucketPipeline,
  githubWorkflow,
} from "../src/commands/templates.js";

test("GitHub recovery restores a named checkpoint from an explicit run with target concurrency", () => {
  const workflow = parse(
    githubWorkflow({ trunk: "main", uat: "partial", production: "prod" }),
  );
  assert.ok(
    workflow.on.workflow_dispatch.inputs.operation.options.includes(
      "deploy-uat",
    ),
  );
  assert.match(
    workflow.jobs["deploy-uat"].if,
    /inputs.operation == 'deploy-uat'/,
  );
  const recovery = workflow.jobs.recover;
  assert.equal(recovery.permissions.actions, "read");
  assert.equal(recovery.permissions.contents, "write");
  assert.equal(recovery.concurrency["cancel-in-progress"], false);
  assert.match(recovery.concurrency.group, /sfci-uat.*sfci-production/);
  const restore = recovery.steps.find(
    (step: { name?: string }) =>
      step.name === "Restore that deployment checkpoint",
  );
  assert.equal(restore.with["run-id"], "${{ inputs.recovery_run }}");
  assert.equal(restore.with.name, "sfci-${{ env.TARGET }}");
  assert.equal(restore.with.path, ".sfci");
  assert.equal(restore.with["github-token"], "${{ secrets.GITHUB_TOKEN }}");
  assert.ok(
    recovery.steps.some(
      (step: { run?: string }) =>
        step.run === 'sfci resume --target "$TARGET" --yes --push',
    ),
  );
  assert.ok(
    !recovery.steps.some((step: { run?: string }) =>
      step.run?.includes("sfci deploy"),
    ),
  );
  for (const name of ["deploy-uat", "deploy-production", "recover"]) {
    const job = workflow.jobs[name];
    const upload = job.steps.find(
      (step: { uses?: string }) => step.uses === "actions/upload-artifact@v4",
    );
    assert.equal(upload.if, "always()");
    assert.match(upload.with.path, /\.sfci\/plans\//);
    assert.match(upload.with.path, /\.sfci\/operations\//);
    assert.doesNotMatch(upload.with.path, /locks|work|tmp|\.sfci\/\*\*/);
  }
});

test("Bitbucket preserves interrupted operation artifacts even on a failed step", () => {
  const pipeline = parse(
    bitbucketPipeline({ trunk: "main", uat: "partial", production: "prod" }),
  );
  const steps = [
    pipeline.pipelines.branches.main[0].step,
    pipeline.pipelines.custom["promote-production"][1].step,
  ];
  for (const step of steps) {
    assert.equal(step.artifacts[0]["capture-on"], "always");
    assert.deepEqual(step.artifacts[0].paths, [
      ".sfci/plans/**",
      ".sfci/operations/**",
    ]);
    assert.ok(
      step.script.some((command: string) => command.includes("--yes --push")),
    );
  }
});

test("every Bitbucket step authenticates with JWT in the intended environment", () => {
  const source = bitbucketPipeline({
    trunk: "main",
    uat: "partial",
    production: "prod",
  });
  const pipeline = parse(source);
  assert.doesNotMatch(source, /SF_AUTH_URL|sfdx-url|org login web/);
  const checks = pipeline.pipelines["pull-requests"]["**"][0].step;
  const uat = pipeline.pipelines.branches.main[0].step;
  const freeze = pipeline.pipelines.custom["promote-production"][0].step;
  const production = pipeline.pipelines.custom["promote-production"][1].step;
  for (const step of [checks, uat, freeze]) {
    assert.equal(step.environment ?? step.deployment, "uat");
    assert.ok(step.script.includes("sfci auth --target uat"));
  }
  assert.equal(production.deployment, "production");
  assert.equal(production.trigger, "manual");
  assert.ok(production.script.includes("sfci auth --target production"));
});

test("GitHub auth steps expose only scoped JWT inputs and use the configured sfci target", () => {
  const source = githubWorkflow({
    trunk: "main",
    uat: "partial",
    production: "prod",
  });
  assert.doesNotMatch(source, /SF_AUTH_URL|sfdx-url|org login web/);
  const workflow = parse(source);
  for (const [name, job] of Object.entries(workflow.jobs) as [
    string,
    { steps: { run?: string; env?: Record<string, string> }[] },
  ][]) {
    const step = job.steps.find((value) => value.run?.startsWith("sfci auth"));
    assert.ok(step, `${name} must authenticate`);
    for (const key of [
      "SF_CLIENT_ID",
      "SF_USERNAME",
      "SF_INSTANCE_URL",
      "SF_JWT_KEY_B64",
    ])
      assert.equal(step.env?.[key], `\${{ secrets.${key} }}`);
  }
});
