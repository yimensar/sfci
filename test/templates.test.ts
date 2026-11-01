import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { bitbucketPipeline, githubWorkflow } from "../src/commands/templates.js";

test("GitHub recovery restores a named checkpoint from an explicit run with target concurrency", () => {
  const workflow = parse(
    githubWorkflow({ trunk: "main", uat: "partial", production: "prod" }),
  );
  assert.ok(workflow.on.workflow_dispatch.inputs.operation.options.includes("deploy-uat"));
  assert.match(workflow.jobs["deploy-uat"].if, /inputs.operation == 'deploy-uat'/);
  const recovery = workflow.jobs.recover;
  assert.equal(recovery.permissions.actions, "read");
  assert.equal(recovery.permissions.contents, "write");
  assert.equal(recovery.concurrency["cancel-in-progress"], false);
  assert.match(recovery.concurrency.group, /sfci-uat.*sfci-production/);
  const restore = recovery.steps.find(
    (step: { name?: string }) => step.name === "Restore that deployment checkpoint",
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
    !recovery.steps.some(
      (step: { run?: string }) => step.run?.includes("sfci deploy"),
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
