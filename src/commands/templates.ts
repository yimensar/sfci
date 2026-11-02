interface PipelineOptions {
  trunk: string;
  uat: string;
  production: string;
}
const image = "ghcr.io/yimensar/sfci:0.1.0-alpha.3";
const expression = (value: string): string => "$" + "{{ " + value + " }}";
const jwtSecrets = [
  "SF_CLIENT_ID",
  "SF_USERNAME",
  "SF_INSTANCE_URL",
  "SF_JWT_KEY_B64",
]
  .map((name) => `          ${name}: ${expression(`secrets.${name}`)}`)
  .join("\n");
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

export function bitbucketPipeline({ trunk }: PipelineOptions): string {
  return `# Set SF_CLIENT_ID, SF_USERNAME, SF_INSTANCE_URL and secured SF_JWT_KEY_B64
# separately in the uat and production deployment environments (JWT only).
# Initialize and push the baseline receipts before the first run.
# Use one deployment coordinator per org. The same concurrency group must cover
# every pipeline that writes to that org; never cancel an active deployment.
# After an interrupted step, restore its exact .sfci artifact before running
# sfci resume --target <environment> --yes --push. Recovery guide:
# https://github.com/yimensar/sfci/blob/main/docs/trunk-based.md
image: ${image}
clone:
  depth: full

pipelines:
  pull-requests:
    '**':
      - step:
          name: Check Salesforce changes
          environment: uat
          concurrency-group: sfci-uat
          script:
            - test "$BITBUCKET_PR_DESTINATION_BRANCH" = ${shellQuote(trunk)}
            - sfci auth --target uat
            - sfci check --target uat
          artifacts:
            - .sfci/plans/**
  branches:
    ${JSON.stringify(trunk)}:
      - step:
          name: Deploy UAT
          deployment: uat
          concurrency-group: sfci-uat
          script:
            - sfci auth --target uat
            - sfci deploy --target uat --yes --push
          artifacts:
            - name: sfci-uat
              paths:
                - .sfci/plans/**
                - .sfci/operations/**
              capture-on: always
  custom:
    promote-production:
      - step:
          name: Freeze the version delivered to UAT
          environment: uat
          concurrency-group: sfci-uat
          script:
            - sfci auth --target uat
            - sfci release --from uat --output .sfci/release.json
          artifacts:
            - .sfci/release.json
      - step:
          name: Deploy frozen release
          trigger: manual
          deployment: production
          concurrency-group: sfci-production
          script:
            - sfci auth --target production
            - sfci deploy --target production --release .sfci/release.json --yes --push
          artifacts:
            - name: sfci-production
              paths:
                - .sfci/plans/**
                - .sfci/operations/**
              capture-on: always
`;
}

export function githubWorkflow({ trunk }: PipelineOptions): string {
  return `# Set SF_CLIENT_ID, SF_USERNAME, SF_INSTANCE_URL and SF_JWT_KEY_B64
# in GitHub environments named uat and production (JWT only).
# Configure required reviewers on production if approval is required.
# Initialize and push baseline receipts before the first run.
# Use one deployment coordinator per org, with the same concurrency group for
# all jobs that write to it. Do not cancel active deployments.
# For recovery, dispatch with the exact failed run ID, before another delivery.
name: Salesforce delivery
on:
  pull_request:
    branches: [${JSON.stringify(trunk)}]
  push:
    branches: [${JSON.stringify(trunk)}]
  workflow_dispatch:
    inputs:
      operation:
        description: Deploy trunk to UAT, promote its release, or recover an interrupted deployment
        type: choice
        options: [promote, deploy-uat, recover-uat, recover-production]
        default: promote
      recovery_run:
        description: Exact workflow run ID containing the interrupted deployment artifact
        type: string
        required: false

permissions:
  contents: read

jobs:
  check:
    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    container: ${image}
    environment: uat
    concurrency:
      group: sfci-uat
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Authenticate UAT
        env:
${jwtSecrets}
        run: sfci auth --target uat
      - run: sfci check --target uat
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: sfci-check
          path: .sfci/plans/
          include-hidden-files: true
  deploy-uat:
    if: github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy-uat')
    runs-on: ubuntu-latest
    container: ${image}
    environment: uat
    permissions:
      contents: write
    concurrency:
      group: sfci-uat
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Authenticate UAT
        env:
${jwtSecrets}
        run: sfci auth --target uat
      - run: sfci deploy --target uat --yes --push
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: sfci-uat
          path: |
            .sfci/plans/
            .sfci/operations/
          include-hidden-files: true
          overwrite: true
          retention-days: 30
  freeze:
    if: github.event_name == 'workflow_dispatch' && inputs.operation == 'promote'
    runs-on: ubuntu-latest
    container: ${image}
    environment: uat
    concurrency:
      group: sfci-uat
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Authenticate UAT
        env:
${jwtSecrets}
        run: sfci auth --target uat
      - run: sfci release --from uat --output .sfci/release.json
      - uses: actions/upload-artifact@v4
        with:
          name: sfci-release
          path: .sfci/release.json
          include-hidden-files: true
  deploy-production:
    needs: freeze
    runs-on: ubuntu-latest
    container: ${image}
    environment: production
    permissions:
      contents: write
    concurrency:
      group: sfci-production
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/download-artifact@v4
        with:
          name: sfci-release
          path: .sfci
      - name: Authenticate production
        env:
${jwtSecrets}
        run: sfci auth --target production
      - run: sfci deploy --target production --release .sfci/release.json --yes --push
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: sfci-production
          path: |
            .sfci/plans/
            .sfci/operations/
          include-hidden-files: true
          overwrite: true
          retention-days: 30
  recover:
    if: github.event_name == 'workflow_dispatch' && startsWith(inputs.operation, 'recover-')
    runs-on: ubuntu-latest
    container: ${image}
    environment: ${expression("inputs.operation == 'recover-uat' && 'uat' || 'production'")}
    permissions:
      contents: write
      actions: read
    concurrency:
      group: ${expression("inputs.operation == 'recover-uat' && 'sfci-uat' || 'sfci-production'")}
      cancel-in-progress: false
    env:
      TARGET: ${expression("inputs.operation == 'recover-uat' && 'uat' || 'production'")}
      RECOVERY_RUN: ${expression("inputs.recovery_run")}
    steps:
      - name: Require an exact interrupted run
        run: |
          case "$RECOVERY_RUN" in
            ''|*[!0-9]*) echo 'Set recovery_run to the exact interrupted workflow run ID.' >&2; exit 1 ;;
          esac
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Restore that deployment checkpoint
        uses: actions/download-artifact@v4
        with:
          name: sfci-${expression("env.TARGET")}
          path: .sfci
          run-id: ${expression("inputs.recovery_run")}
          github-token: ${expression("secrets.GITHUB_TOKEN")}
      - name: Authenticate target
        env:
${jwtSecrets}
        run: sfci auth --target "$TARGET"
      - run: sfci resume --target "$TARGET" --yes --push
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: sfci-${expression("env.TARGET")}
          path: |
            .sfci/plans/
            .sfci/operations/
          include-hidden-files: true
          overwrite: true
          retention-days: 30
`;
}
