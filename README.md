# sfci

Fast, guided Salesforce delivery.

`sfci` is a small, standalone CLI for trunk-based Salesforce delivery. Keep ordinary Git commits, calculate changes from the last successful deployment of each org, and promote a frozen version through your environments.

**Early alpha.** The local test suite uses real Git repositories and Git Delta, with simulated Salesforce responses. Live-org acceptance is still required before using this release for production. Versioned Flow deletion is explicitly blocked in this alpha.

Known inherited dependency audit findings are recorded in [the alpha dependency status](docs/security.md). Initial startup measurements are in [performance measurements](docs/performance.md).

## Start

From the source repository:

```sh
nix develop
npm ci
npm run check
node bin/sfci.js --help
```

Or build the complete, pinned runtime:

```sh
nix build
./result/bin/sfci --help
./result/bin/sf --version
```

The npm package is named `@yimensar/sfci`. It is not published to npm yet. The repository CI builds a package artifact and publishes the Linux CI image after its checks pass. See [Nix and image distribution](docs/nix.md) for the current image tags and first-publication visibility setting.

The npm distribution requires Node 22.12+ and Git. Nix and the CI image also provide Node, Git, and the bundled Salesforce CLI. Git Delta is called as a library; no global plugin installation is needed.

## Set up a Salesforce project

In an existing Git repository containing `sfdx-project.json`:

```sh
sfci init
```

`init` guides you through the environments and CI provider. In automation, supply the answers explicitly:

```sh
sfci init --ci bitbucket --uat partial --production production
```

It creates `sfci.yml`, ignores generated state under `.sfci/`, and writes a GitHub Actions or Bitbucket Pipelines template. Existing configurations are preserved; an existing pipeline gets a separate example to review and integrate.

```yaml
trunk: main

environments:
  uat:
    org: partial
    tests: RunLocalTests
  production:
    org: production
    tests: RunLocalTests
    promoteFrom: uat
```

Connect each org with Salesforce CLI. Nix and the image expose the bundled `sf` command. For example, use your existing web/JWT authentication, or configure the generated pipeline's protected `SF_AUTH_URL` environment secret. Never commit authentication files or include Salesforce CLI authentication directories in artifacts.

```sh
sfci auth --target uat --instance-url https://test.salesforce.com
sfci doctor --target uat
```

Before the first deployment, record the Git commit known to represent **each** org:

```sh
sfci baseline set --target uat --commit <verified-uat-commit> --push
sfci baseline set --target production --commit <verified-production-commit> --push
```

A baseline is an assertion by the operator, not an automatic comparison with Salesforce. Do not choose an arbitrary commit to bypass setup. Existing `deploy/preprod/*` or `deploy/prod/*` tags can be used as the `--commit` reference after verifying their correspondence to the target org. `sfci` records its own structured receipt without rewriting the old tags.

Commit the setup files before preparing a plan. Configure required PR checks and branch protections in your Git host; generating a pipeline does not configure those settings.

## Deliver

| Command | Purpose |
| --- | --- |
| `sfci check --target uat` | Snapshot committed sources, calculate the cumulative delta, and validate it in UAT. |
| `sfci plan --target uat` | Prepare and inspect a plan without submitting a metadata validation. |
| `sfci deploy --target uat --push` | Deploy the selected trunk version and publish its successful receipt. |
| `sfci release --from uat --output .sfci/release.json` | Freeze the last successful sfci deployment from UAT. |
| `sfci deploy --target production --release .sfci/release.json --push` | Validate and deploy that exact version using the production baseline. |
| `sfci status` | Show recorded baselines and local operations needing attention. |
| `sfci resume --target uat --push` | Reconcile a preserved deployment operation without submitting it again. |

Use `--yes` to confirm mutations in CI, `--json` for a structured result, and `--verbose` for diagnostics. Metadata deletion requires a separate `--allow-destructive` flag. `--mode full` deploys the configured source directories while retaining explicit Git-derived deletions; it does not purge unknown org metadata.

Plans live under `.sfci/plans/<id>/`. Each plan contains its own committed source snapshot, manifests, org identity, configuration fingerprint, and file hashes. Keep the **whole directory**, not just `plan.json`, when moving it between CI steps.

```sh
sfci check --target uat --plan .sfci/plans/<id>/plan.json
sfci deploy --target uat --plan .sfci/plans/<id>/plan.json --push
```

The production path uses a successful production validation followed by Salesforce Quick Deploy. A UAT validation is never reused for production. Tests default to `RunLocalTests`; `NoTestRun` is rejected for actual production orgs.

## What is recorded

Annotated tags under `sfci/<environment>/` contain structured deployment receipts: org ID, source commit, predecessor, sequence, plan ID, Salesforce job ID, and completion time. Tags are created only after confirmed success. Receipt order uses a sequence rather than the timestamp of an arbitrary Git tag; conflicting sequences stop the operation.

For example, if UAT is on A and deployment B fails, the next plan for C starts at **A**, not B or `HEAD^`. Production has its own independent baseline.

## Recovery and operating limits

- Serialize Salesforce checks and deployments for the same org in your CI. The generated templates do this. The local lock does not coordinate separate checkouts, repositories, or deployments made outside sfci.
- Keep `.sfci/operations/` and its referenced plan directory as protected CI artifacts, including on failure. Operation state is local to the workspace; a fresh runner cannot discover another runner's lost state automatically.
- After a pipeline interruption, inspect Salesforce Deployment Status and restore its operation artifacts before retrying. `resume` can finish polling a known job or retry publishing a receipt after Salesforce succeeded. An ambiguous submission without a returned job ID requires operator reconciliation.
- A receipt describes the last deployment known to sfci. It does not detect manual changes in an org. Reconcile those changes, or a sandbox refresh, before resetting a verified baseline.
- Automatic metadata dependency discovery is limited to Git Delta's behavior. A successful delta validation does not prove every external dependency or future full deployment will work.
- Source snapshots currently reject symbolic links, submodules and Git LFS pointers. Deployments do not run Apex/data migrations, activate feature flags, or promise automatic rollback.
- The first image targets Linux x86-64. Nix development and CLI builds support Apple Silicon macOS and the declared Linux platforms; image builds run on Linux.

## Develop

```sh
npm run typecheck
npm test
npm run build
nix flake check
```

The core has no dependency on the terminal UI or a CI provider. Salesforce calls use the package's private CLI dependency, Git Delta is imported only for planning, and interactive prompts are loaded only when needed. Help and version do not connect to Salesforce.

The implementation is original. The existing Guimini pipeline informed the workflow requirements; no customer metadata, data, credentials, or Hardis source are included.

## License

MIT, copyright Yan Imensar. Dependency licenses remain their own; see [third-party notices](THIRD_PARTY_NOTICES.md).
