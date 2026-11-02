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
  for (const key of [
    "SF_CLIENT_ID",
    "SFDX_CLIENT_ID",
    "SF_USERNAME",
    "SF_INSTANCE_URL",
    "SF_JWT_KEY_FILE",
    "SF_JWT_KEY_B64",
  ])
    delete environment[key];
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
  assert.match(version.stdout, /^0\.1\.0-alpha\.4\n$/);
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
    /--ci bitbucket/,
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
      "--environment",
      "uat:sandbox:partial",
      "--environment",
      "production:production:production",
      "--promote",
      "uat:production",
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
  assert.match(pipeline, /ghcr\.io\/yimensar\/sfci:0\.1\.0-alpha\.4/);
  assert.match(pipeline, /head\.repo\.full_name == github\.repository/);
  assert.doesNotMatch(pipeline, /pull_request_target/);
  assert.match(pipeline, /\$\{\{ secrets\.SF_JWT_KEY_B64 \}\}/);
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
      "--environment",
      "uat:sandbox:partial",
      "--environment",
      "production:production:production",
      "--promote",
      "uat:production",
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
      "--environment",
      "uat:sandbox:partial",
      "--environment",
      "production:production:prod",
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
      "--environment",
      "uat:sandbox:partial",
      "--environment",
      "production:production:prod",
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
      "--environment",
      "uat:sandbox:bad; echo bad",
      "--environment",
      "production:production:prod",
    ],
    root,
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Invalid environment/);
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
      "--environment",
      "uat:sandbox:partial",
      "--environment",
      "production:production:prod",
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
      environments: {
        uat: { org: "partial", type: "sandbox", tests: "RunLocalTests" },
        production: {
          org: "production",
          type: "production",
          tests: "RunLocalTests",
          promoteFrom: "uat",
        },
      },
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
    githubWorkflow({
      trunk: "main",
      environments: {
        uat: { org: "partial", type: "sandbox", tests: "RunLocalTests" },
        production: {
          org: "production",
          type: "production",
          tests: "RunLocalTests",
          promoteFrom: "uat",
        },
      },
    }),
  ) as {
    jobs: {
      "freeze-production": { environment: string };
      "deploy-production": {
        steps: { uses?: string; with?: { path?: string } }[];
      };
    };
  };
  assert.equal(workflow.jobs["freeze-production"].environment, "uat");
  assert.equal(
    workflow.jobs["deploy-production"].steps.find(
      (step) => step.uses === "actions/download-artifact@v4",
    )?.with?.path,
    ".sfci",
  );
});

test("Bitbucket trunk condition quotes shell metacharacters safely", () => {
  const trunk = "topic/$(printf-owned)";
  const yaml = bitbucketPipeline({
    trunk,
    environments: {
      uat: { org: "uat", type: "sandbox", tests: "RunLocalTests" },
      production: {
        org: "prod",
        type: "production",
        tests: "RunLocalTests",
        promoteFrom: "uat",
      },
    },
  });
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

test("JWT auth works in noninteractive mode and rejects missing credentials without opening a browser", async () => {
  const cwd = await project();
  await writeFile(
    join(cwd, "sfci.yml"),
    "trunk: main\nenvironments:\n  uat:\n    org: partial\n",
  );
  const structured = run(["--json", "auth", "--target", "uat"], cwd);
  assert.equal(structured.status, 1);
  const body = JSON.parse(structured.stdout);
  assert.equal(body.error.code, "AUTH_CONFIG");
  assert.match(body.error.message, /SF_CLIENT_ID/);
  assert.equal(structured.stderr, "");
  const ci = run(["auth", "--target", "uat"], cwd);
  assert.equal(ci.status, 1);
  assert.match(ci.stderr, /SF_CLIENT_ID/);
  assert.doesNotMatch(ci.stderr, /interactive|browser/);
});

test("JWT auth only accepts an HTTPS origin without embedded credentials", () => {
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

test("init supports freely named environments and pipeline regeneration preserves the current pipeline", async () => {
  const cwd = await project();
  const result = run(
    [
      "--json",
      "init",
      "--ci",
      "bitbucket",
      "--environment",
      "integration:sandbox:int",
      "--environment",
      "staging:sandbox:stage",
      "--environment",
      "live:production:prod",
      "--promote",
      "integration:staging",
      "--promote",
      "staging:live",
    ],
    cwd,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const config = parse(await readFile(join(cwd, "sfci.yml"), "utf8"));
  assert.deepEqual(Object.keys(config.environments), [
    "integration",
    "staging",
    "live",
  ]);
  assert.equal(config.environments.live.type, "production");
  const original = await readFile(join(cwd, "bitbucket-pipelines.yml"), "utf8");
  const regenerate = run(["--json", "pipeline", "--ci", "bitbucket"], cwd);
  assert.equal(regenerate.status, 0, regenerate.stdout);
  assert.equal(
    await readFile(join(cwd, "bitbucket-pipelines.yml"), "utf8"),
    original,
  );
  assert.equal(
    await readFile(join(cwd, "sfci.bitbucket.example.yml"), "utf8"),
    original,
  );
});

test("bootstrap parses its inherited target/username and requires an explicit administrator", async () => {
  const cwd = await project();
  await writeFile(
    join(cwd, "sfci.yml"),
    "trunk: main\nenvironments:\n  qa:\n    type: sandbox\n    org: delivery\n",
  );
  const result = run(
    [
      "--json",
      "auth",
      "bootstrap",
      "--target",
      "qa",
      "--username",
      "ci@example.invalid",
      "--admin-org",
      "delivery",
      "--yes",
    ],
    cwd,
  );
  assert.equal(result.status, 1);
  assert.match(
    JSON.parse(result.stdout).error.message,
    /separate administrator alias/,
  );
});
