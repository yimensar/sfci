interface PipelineOptions {
  trunk: string;
  uat: string;
  production: string;
}
const image = "ghcr.io/yimensar/sfci:0.1.0-alpha.1";
const authSecret = "$" + "{{ secrets.SF_AUTH_URL }}";
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", "'\\''")}'`;

export function bitbucketPipeline({
  trunk,
  uat,
  production,
}: PipelineOptions): string {
  return `# Set SF_AUTH_URL separately in the uat and production deployment environments.
# Initialize and push the baseline receipts before the first run.
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
            - printf '%s' "$SF_AUTH_URL" | sf org login sfdx-url --alias ${uat} --sfdx-url-stdin
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
            - printf '%s' "$SF_AUTH_URL" | sf org login sfdx-url --alias ${uat} --sfdx-url-stdin
            - sfci deploy --target uat --yes --push
          artifacts:
            - .sfci/**
  custom:
    promote-production:
      - step:
          name: Freeze the version delivered to UAT
          environment: uat
          concurrency-group: sfci-uat
          script:
            - printf '%s' "$SF_AUTH_URL" | sf org login sfdx-url --alias ${uat} --sfdx-url-stdin
            - sfci release --from uat --output .sfci/release.json
          artifacts:
            - .sfci/release.json
      - step:
          name: Deploy frozen release
          trigger: manual
          deployment: production
          concurrency-group: sfci-production
          script:
            - printf '%s' "$SF_AUTH_URL" | sf org login sfdx-url --alias ${production} --sfdx-url-stdin
            - sfci deploy --target production --release .sfci/release.json --yes --push
          artifacts:
            - .sfci/**
`;
}

export function githubWorkflow({
  trunk,
  uat,
  production,
}: PipelineOptions): string {
  return `# Set SF_AUTH_URL in GitHub environments named uat and production.
# Configure required reviewers on production if approval is required.
# Initialize and push baseline receipts before the first run.
name: Salesforce delivery
on:
  pull_request:
    branches: [${JSON.stringify(trunk)}]
  push:
    branches: [${JSON.stringify(trunk)}]
  workflow_dispatch:

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
          SF_AUTH_URL: ${authSecret}
        run: printf '%s' "$SF_AUTH_URL" | sf org login sfdx-url --alias ${uat} --sfdx-url-stdin
      - run: sfci check --target uat
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: sfci-check
          path: .sfci/plans/
          include-hidden-files: true
  deploy-uat:
    if: github.event_name == 'push'
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
          SF_AUTH_URL: ${authSecret}
        run: printf '%s' "$SF_AUTH_URL" | sf org login sfdx-url --alias ${uat} --sfdx-url-stdin
      - run: sfci deploy --target uat --yes --push
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: sfci-uat
          path: .sfci/
          include-hidden-files: true
  freeze:
    if: github.event_name == 'workflow_dispatch'
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
          SF_AUTH_URL: ${authSecret}
        run: printf '%s' "$SF_AUTH_URL" | sf org login sfdx-url --alias ${uat} --sfdx-url-stdin
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
          SF_AUTH_URL: ${authSecret}
        run: printf '%s' "$SF_AUTH_URL" | sf org login sfdx-url --alias ${production} --sfdx-url-stdin
      - run: sfci deploy --target production --release .sfci/release.json --yes --push
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: sfci-production
          path: .sfci/
          include-hidden-files: true
`;
}
