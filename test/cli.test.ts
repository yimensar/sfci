import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { parse } from "yaml";
import {
  bitbucketPipeline,
  githubWorkflow,
} from "../src/commands/templates.js";
import { validateInstanceUrl } from "../src/commands/auth.js";
import { redact } from "../src/ui.js";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = resolve(projectRoot, "src/cli.ts");
const temporaryProjects: string[] = [];
after(async () => {
  await Promise.all(
    temporaryProjects.map((path) => rm(path, { recursive: true, force: true })),
  );
});

function run(args: string[], cwd = projectRoot) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "true",
    NO_COLOR: "1",
  };
  delete environment.FORCE_COLOR;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "--cwd", cwd, ...args],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: environment,
    },
  );
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sfci-cli-"));
  temporaryProjects.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFile(
    join(root, "sfdx-project.json"),
    JSON.stringify({
      packageDirectories: [{ path: "force-app", default: true }],
      sourceApiVersion: "67.0",
    }),
  );
  return root;
}

test("help and version work without a Salesforce project or connection", () => {
  const help = run(["--help"], tmpdir());
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Fast, guided Salesforce delivery/);
  assert.match(help.stdout, /resume/);
  assert.equal(help.stderr, "");
  const version = run(["--version"], tmpdir());
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^0\.1\.0-alpha\.2\n$/);
});

test("usage errors are one structured JSON result without terminal formatting", () => {
  const result = run(["--json", "not-a-command"]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout) as {
    schemaVersion: number;
    error: { code: string; message: string; hint: string };
  };
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.error.code, "USAGE");
  assert.match(body.error.message, /unknown command/);
  assert.match(body.error.hint, /--help/);
  assert.equal(result.stderr, "");
});

test("missing required options fail before running Salesforce", () => {
  const result = run(["--json", "deploy"]);
  assert.equal(result.status, 1);
  assert.match(
    (JSON.parse(result.stdout) as { error: { message: string } }).error.message,
    /target/,
  );
});

test("init in CI requires explicit answers and creates no configuration", async () => {
  const root = await project();
  const result = run(["--json", "init"], root);
  assert.equal(result.status, 1);
  assert.match(
    (JSON.parse(result.stdout) as { error: { hint: string } }).error.hint,
    /--ci github/,
  );
  await assert.rejects(readFile(join(root, "sfci.yml")), { code: "ENOENT" });
});

test("init creates a working configuration and GitHub workflow", async () => {
  const root = await project();
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  const result = run(
    [
      "init",
      "--ci",
      "github",
      "--uat",
      "partial",
      "--production",
      "production",
      "--json",
    ],
    root,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const body = JSON.parse(result.stdout) as { result: { files: string[] } };
  assert.deepEqual(body.result.files, [
    "sfci.yml",
    ".github/workflows/sfci.yml",
  ]);
  const config = parse(await readFile(join(root, "sfci.yml"), "utf8")) as {
    trunk: string;
    environments: Record<
      string,
      { org: string; tests: string; promoteFrom?: string }
    >;
  };
  assert.equal(config.trunk, "main");
  assert.equal(config.environments.uat?.org, "partial");
  assert.equal(config.environments.production?.promoteFrom, "uat");
  assert.equal(config.environments.production?.tests, "RunLocalTests");
  assert.equal(
    await readFile(join(root, ".gitignore"), "utf8"),
    "node_modules/\n.sfci/\n",
  );
  const pipeline = await readFile(
    join(root, ".github/workflows/sfci.yml"),
    "utf8",
  );
  assert.match(pipeline, /ghcr\.io\/yimensar\/sfci:0\.1\.0-alpha\.2/);
  assert.match(pipeline, /head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(pipeline, /pull_request_target/);
  assert.match(pipeline, /\$\{\{ secrets\.SF_AUTH_URL \}\}/);
});

test("init preserves an existing pipeline and generates a separate example", async () => {
  const root = await project();
  await writeFile(
    join(root, "bitbucket-pipelines.yml"),
    "# existing pipeline\n",
  );
  const result = run(
    [
      "--json",
      "init",
      "--ci",
      "bitbucket",
      "--uat",
      "partial",
      "--production",
      "production",
    ],
    root,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    await readFile(join(root, "bitbucket-pipelines.yml"), "utf8"),
    "# existing pipeline\n",
  );
  const example = await readFile(
    join(root, "sfci.bitbucket.example.yml"),
    "utf8",
  );
  assert.ok(
    example.includes(
      "sfci deploy --target production --release .sfci/release.json --yes --push",
    ),
  );
  assert.match(result.stdout, /Existing pipeline kept/);
});

test("init never replaces an existing sfci configuration", async () => {
  const root = await project();
  await writeFile(join(root, "sfci.yml"), "# hand-written configuration\n");
  const result = run(
    [
      "--json",
      "init",
      "--ci",
      "github",
      "--uat",
      "uat",
      "--production",
      "prod",
    ],
    root,
  );
  assert.equal(result.status, 1);
  assert.equal(
    await readFile(join(root, "sfci.yml"), "utf8"),
    "# hand-written configuration\n",
  );
  await assert.rejects(readFile(join(root, ".github/workflows/sfci.yml")), {
    code: "ENOENT",
  });
});

test("init refuses an existing example before writing any configuration", async () => {
  const root = await project();
  await writeFile(join(root, "bitbucket-pipelines.yml"), "# pipeline\n");
  await writeFile(join(root, "sfci.bitbucket.example.yml"), "# example\n");
  const result = run(
    [
      "--json",
      "init",
      "--ci",
      "bitbucket",
      "--uat",
      "uat",
      "--production",
      "prod",
    ],
    root,
  );
  assert.equal(result.status, 1);
  await assert.rejects(readFile(join(root, "sfci.yml")), { code: "ENOENT" });
});

test("init refuses aliases that would inject commands into CI templates", async () => {
  const root = await project();
  const result = run(
    [
      "--json",
      "init",
      "--ci",
      "bitbucket",
      "--uat",
      "uat; echo bad",
      "--production",
      "prod",
    ],
    root,
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /simple org alias/);
  await assert.rejects(readFile(join(root, "sfci.yml")), { code: "ENOENT" });
});

test("init refuses a symbolic .gitignore before writing project files", async () => {
  const root = await project();
  await writeFile(join(root, "existing-ignore"), "# preserve this file\n");
  await symlink("existing-ignore", join(root, ".gitignore"));
  const result = run(
    [
      "--json",
      "init",
      "--ci",
      "github",
      "--uat",
      "uat",
      "--production",
      "prod",
    ],
    root,
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /regular file/);
  assert.equal(
    await readFile(join(root, "existing-ignore"), "utf8"),
    "# preserve this file\n",
  );
  await assert.rejects(readFile(join(root, "sfci.yml")), { code: "ENOENT" });
});

test("generated YAML is valid and uses a frozen release for production", () => {
  for (const generator of [bitbucketPipeline, githubWorkflow]) {
    const yaml = generator({
      trunk: "main",
      uat: "partial",
      production: "production",
    });
    assert.doesNotThrow(() => parse(yaml));
    assert.ok(
      yaml.includes("sfci release --from uat --output .sfci/release.json"),
    );
    assert.ok(
      yaml.includes(
        "sfci deploy --target production --release .sfci/release.json --yes --push",
      ),
    );
    assert.doesNotMatch(yaml, /npm install|sf plugins install|apt-get|python/);
  }
  const workflow = parse(
    githubWorkflow({ trunk: "main", uat: "partial", production: "production" }),
  ) as {
    jobs: {
      freeze: { environment: string };
      "deploy-production": {
        steps: { uses?: string; with?: { path?: string } }[];
      };
    };
  };
  assert.equal(workflow.jobs.freeze.environment, "uat");
  assert.equal(
    workflow.jobs["deploy-production"].steps.find(
      (step) => step.uses === "actions/download-artifact@v4",
    )?.with?.path,
    ".sfci",
  );
});

test("Bitbucket trunk condition quotes shell metacharacters safely", () => {
  const trunk = "topic/$(printf-owned)";
  const yaml = bitbucketPipeline({ trunk, uat: "uat", production: "prod" });
  assert.match(
    yaml,
    /test "\$BITBUCKET_PR_DESTINATION_BRANCH" = 'topic\/\$\(printf-owned\)'/,
  );
});

test("baseline recording requires explicit confirmation in CI", () => {
  const result = run([
    "--json",
    "baseline",
    "set",
    "--target",
    "uat",
    "--commit",
    "HEAD",
  ]);
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout) as {
    error: { message: string; hint: string };
  };
  assert.equal(body.error.message, "Confirmation required.");
  assert.match(body.error.hint, /--yes/);
});

test("web auth rejects JSON and CI without starting an authentication flow", () => {
  const structured = run(["--json", "auth", "--target", "uat"]);
  assert.equal(structured.status, 1);
  assert.equal(
    (JSON.parse(structured.stdout) as { error: { message: string } }).error
      .message,
    "Web authentication does not support --json.",
  );
  const ci = run(["auth", "--target", "uat"]);
  assert.equal(ci.status, 1);
  assert.match(ci.stderr, /needs an interactive terminal/);
});

test("web auth only accepts an HTTPS origin without embedded credentials", () => {
  assert.doesNotThrow(() => validateInstanceUrl("https://test.salesforce.com"));
  assert.doesNotThrow(() =>
    validateInstanceUrl("https://my-org.my.salesforce.com/"),
  );
  for (const url of [
    "http://test.salesforce.com",
    "https://user:secret@test.salesforce.com",
    "https://test.salesforce.com/path",
    "https://test.salesforce.com?token=secret",
    "not a URL",
  ]) {
    assert.throws(
      () => validateInstanceUrl(url),
      /Invalid Salesforce instance URL/,
    );
  }
});

test("diagnostics redact authentication URLs and secrets from the environment", () => {
  const old = process.env.SFCI_TEST_TOKEN;
  process.env.SFCI_TEST_TOKEN = "test-secret-value";
  try {
    const safe = redact(
      "Fetch https://git-user:test-secret-value@example.invalid/repo and force://client:secret:refresh@example.invalid failed: test-secret-value",
    );
    assert.doesNotMatch(safe, /test-secret-value|client:secret:refresh/);
    assert.match(safe, /https:\/\/\[REDACTED\]@example.invalid/);
  } finally {
    if (old === undefined) delete process.env.SFCI_TEST_TOKEN;
    else process.env.SFCI_TEST_TOKEN = old;
  }
});
