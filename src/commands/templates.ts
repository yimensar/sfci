import { stringify } from "yaml";
import type { Config } from "../core/types.js";

const serialize = (value: unknown): string =>
  stringify(value, { lineWidth: 0, aliasDuplicateObjects: false });
const image = "ghcr.io/yimensar/sfci:0.1.0-alpha.5";
const expression = (value: string): string => "$" + "{{ " + value + " }}";
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;
const jwtVariables = [
  "SF_CLIENT_ID",
  "SF_USERNAME",
  "SF_INSTANCE_URL",
  "SF_JWT_KEY_B64",
];
const artifacts = (target: string) => [
  {
    name: `sfci-${target}`,
    paths: [".sfci/plans/**", ".sfci/operations/**"],
    "capture-on": "always",
  },
];
const header = `# JWT variables belong to each named CI environment; secure SF_JWT_KEY_B64.
# Initialize the verified baseline of every org before the first normal run.
# Use one coordinator per actual org. Do not cancel running deployments.
# Preserve exact plans/operations after failures; never restore locks/work/tmp.
# Recovery and bootstrap: https://github.com/yimensar/sfci/tree/main/docs
`;

export function bitbucketPipeline(config: Config): string {
  const roots = Object.entries(config.environments).filter(
    ([, env]) => !env.promoteFrom,
  );
  const custom: Record<string, unknown> = {};
  for (const [name, env] of Object.entries(config.environments)) {
    if (!env.promoteFrom) continue;
    custom[`promote-${name}`] = [
      {
        step: {
          name: `Freeze release from ${env.promoteFrom}`,
          environment: env.promoteFrom,
          "concurrency-group": `sfci-${env.promoteFrom}`,
          script: [
            `sfci auth --target ${env.promoteFrom}`,
            `sfci release --from ${env.promoteFrom} --output .sfci/release.json`,
          ],
          artifacts: [".sfci/release.json"],
        },
      },
      {
        step: {
          name: `Deploy ${name}`,
          trigger: "manual",
          deployment: name,
          "concurrency-group": `sfci-${name}`,
          script: [
            `sfci auth --target ${name}`,
            `sfci deploy --target ${name} --release .sfci/release.json --yes --push`,
          ],
          artifacts: artifacts(name),
        },
      },
    ];
  }
  const pipelines: Record<string, unknown> = {
    "pull-requests": {
      "**": roots.map(([name]) => ({
        step: {
          name: `Check ${name}`,
          environment: name,
          "concurrency-group": `sfci-${name}`,
          script: [
            `test "$BITBUCKET_PR_DESTINATION_BRANCH" = ${shellQuote(config.trunk)}`,
            `sfci auth --target ${name}`,
            `sfci check --target ${name}`,
          ],
          artifacts: [".sfci/plans/**"],
        },
      })),
    },
    ...(Object.keys(custom).length ? { custom } : {}),
  };
  // Bitbucket forbids a manual first step. Only an explicit sandbox deploys automatically.
  for (const [name, env] of roots)
    if (env.type !== "sandbox") {
      custom[`deploy-${name}`] = [
        {
          step: {
            name: `Deploy ${name}`,
            deployment: name,
            "concurrency-group": `sfci-${name}`,
            script: [
              `sfci auth --target ${name}`,
              `sfci deploy --target ${name} --yes --push`,
            ],
            artifacts: artifacts(name),
          },
        },
      ];
    }
  const automatic = roots.filter(([, env]) => env.type === "sandbox");
  if (automatic.length)
    pipelines.branches = {
      [config.trunk]: automatic.map(([name]) => ({
        step: {
          name: `Deploy ${name}`,
          deployment: name,
          "concurrency-group": `sfci-${name}`,
          script: [
            `sfci auth --target ${name}`,
            `sfci deploy --target ${name} --yes --push`,
          ],
          artifacts: artifacts(name),
        },
      })),
    };
  if (Object.keys(custom).length) pipelines.custom = custom;
  return header + serialize({ image, clone: { depth: "full" }, pipelines });
}

export function githubWorkflow(config: Config): string {
  const names = Object.keys(config.environments);
  const jwtEnv = Object.fromEntries(
    jwtVariables.map((name) => [name, expression(`secrets.${name}`)]),
  );
  const checkout = { uses: "actions/checkout@v4", with: { "fetch-depth": 0 } };
  const auth = (name: string) => ({
    name: "Authenticate with JWT",
    env: jwtEnv,
    run: `sfci auth --target ${name}`,
  });
  const upload = (name: string) => ({
    uses: "actions/upload-artifact@v4",
    if: "always()",
    with: {
      name: `sfci-${name}`,
      path: ".sfci/plans/\n.sfci/operations/",
      "include-hidden-files": true,
      overwrite: true,
      "retention-days": 30,
    },
  });
  const base = (name: string) => ({
    "runs-on": "ubuntu-latest",
    container: image,
    environment: name,
    concurrency: { group: `sfci-${name}`, "cancel-in-progress": false },
  });
  const jobs: Record<string, unknown> = {};
  for (const [name, env] of Object.entries(config.environments)) {
    if (!env.promoteFrom) {
      jobs[`check-${name}`] = {
        ...base(name),
        if: "github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository",
        steps: [
          checkout,
          auth(name),
          { run: `sfci check --target ${name}` },
          upload(name),
        ],
      };
      jobs[`deploy-${name}`] = {
        ...base(name),
        permissions: { contents: "write" },
        if:
          (env.type === "sandbox" ? "github.event_name == 'push' || " : "") +
          `(github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy' && inputs.target == '${name}')`,
        steps: [
          checkout,
          auth(name),
          { run: `sfci deploy --target ${name} --yes --push` },
          upload(name),
        ],
      };
    } else {
      jobs[`freeze-${name}`] = {
        ...base(env.promoteFrom),
        if: `github.event_name == 'workflow_dispatch' && inputs.operation == 'promote' && inputs.target == '${name}'`,
        steps: [
          checkout,
          auth(env.promoteFrom),
          {
            run: `sfci release --from ${env.promoteFrom} --output .sfci/release.json`,
          },
          {
            uses: "actions/upload-artifact@v4",
            with: {
              name: `sfci-release-${name}`,
              path: ".sfci/release.json",
              "include-hidden-files": true,
            },
          },
        ],
      };
      jobs[`deploy-${name}`] = {
        ...base(name),
        needs: `freeze-${name}`,
        permissions: { contents: "write" },
        steps: [
          checkout,
          {
            uses: "actions/download-artifact@v4",
            with: { name: `sfci-release-${name}`, path: ".sfci" },
          },
          auth(name),
          {
            run: `sfci deploy --target ${name} --release .sfci/release.json --yes --push`,
          },
          upload(name),
        ],
      };
    }
  }
  jobs.recover = {
    ...base(expression("inputs.target")),
    if: "github.event_name == 'workflow_dispatch' && inputs.operation == 'recover'",
    permissions: { contents: "write", actions: "read" },
    env: {
      TARGET: expression("inputs.target"),
      RECOVERY_RUN: expression("inputs.recovery_run"),
    },
    steps: [
      {
        name: "Require an exact interrupted run",
        run: `case "$RECOVERY_RUN" in ''|*[!0-9]*) echo 'Set recovery_run to the interrupted run ID.' >&2; exit 1 ;; esac`,
      },
      checkout,
      {
        name: "Restore that deployment checkpoint",
        uses: "actions/download-artifact@v4",
        with: {
          name: "sfci-" + expression("inputs.target"),
          path: ".sfci",
          "run-id": expression("inputs.recovery_run"),
          "github-token": expression("secrets.GITHUB_TOKEN"),
        },
      },
      auth('"$TARGET"'),
      { run: 'sfci resume --target "$TARGET" --yes --push' },
      upload(expression("inputs.target")),
    ],
  };
  return (
    header +
    serialize({
      name: "Salesforce delivery",
      on: {
        pull_request: { branches: [config.trunk] },
        push: { branches: [config.trunk] },
        workflow_dispatch: {
          inputs: {
            operation: {
              description: "Deploy trunk, promote a release, or recover a job",
              type: "choice",
              options: ["deploy", "promote", "recover"],
              default: "promote",
            },
            target: {
              description: "Configured environment",
              type: "choice",
              options: names,
              required: true,
            },
            recovery_run: {
              description: "Exact interrupted workflow run ID",
              type: "string",
              required: false,
            },
          },
        },
      },
      permissions: { contents: "read" },
      jobs,
    })
  );
}
