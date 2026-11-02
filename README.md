# sfci

Fast, guided Salesforce delivery.

`sfci` is a small, standalone CLI for trunk-based Salesforce delivery. Keep ordinary Git commits, calculate changes from the last successful deployment of each org, and promote a frozen version through your environments.

**Early alpha.** The local test suite uses real Git repositories and Git Delta, with simulated Salesforce responses. Live-org acceptance is still required before using this release for production. Versioned Flow deletion is explicitly blocked in this alpha.

Known inherited dependency audit findings are recorded in [the alpha dependency status](docs/security.md). Initial startup measurements are in [performance measurements](docs/performance.md).

## Start

Install the complete runtime with Nix:

```sh
nix profile add github:yimensar/sfci/v0.1.0-alpha.4
sfci init
```

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
sfci init --ci bitbucket \
  --environment preprod:sandbox:partial \
  --environment prod:production:production \
  --promote preprod:prod
```

It creates `sfci.yml`, ignores generated state under `.sfci/`, and writes a Bitbucket Pipelines or GitHub Actions template. Existing configurations are preserved; an existing pipeline gets a separate example to review and integrate. Environment names and promotion links are configurable; each environment has a sandbox or production type.

```yaml
trunk: main

environments:
  preprod:
    type: sandbox
    org: partial
    tests: RunLocalTests
  prod:
    type: production
    org: production
    tests: RunLocalTests
    promoteFrom: preprod
```

CI authentication uses JWT exclusively, through the bundled Salesforce CLI. Set these variables separately in the Bitbucket environments with the names declared in sfci.yml:

| Variable | Value |
| --- | --- |
| `SF_CLIENT_ID` | OAuth application consumer key/client ID. Existing `SFDX_CLIENT_ID` variables are also accepted. |
| `SF_USERNAME` | Authorized Salesforce integration user. |
| `SF_INSTANCE_URL` | HTTPS Salesforce login or My Domain URL. |
| `SF_JWT_KEY_B64` | Base64-encoded RSA private key, stored as a secured variable. |

The Salesforce application must trust the corresponding certificate and authorize the integration user. The experimental `sfci auth bootstrap` command can create these resources from an existing administrator connection. sfci calls `sf org login jwt`; it does not implement JWT signing or token storage. It writes the decoded key to a private temporary file, removes it after the authentication attempt, and never prints the access token returned by Salesforce. See the [Bitbucket and JWT setup guide](docs/bitbucket-jwt.md).

```sh
sfci auth --target preprod
sfci doctor --target preprod
```

Locally, existing Salesforce CLI aliases and authenticated orgs remain usable. To connect explicitly with a key file, use `sfci auth --target preprod --client-id <id> --username <user> --instance-url <url> --jwt-key-file <path>`. The same inputs can be supplied through environment variables, including `SF_JWT_KEY_FILE` instead of base64. Keep keys and Salesforce authentication directories outside Git, CI artifacts and the Nix store.

Before the first deployment, record the Git commit known to represent **each** org:

```sh
sfci baseline set --target preprod --commit <verified-preprod-commit> --push
sfci baseline set --target prod --commit <verified-production-commit> --push
```

A baseline is an assertion by the operator, not an automatic comparison with Salesforce. Do not choose an arbitrary commit to bypass setup. Existing `deploy/preprod/*` or `deploy/prod/*` tags can be used as the `--commit` reference after verifying their correspondence to the target org. `sfci` records its own structured receipt without rewriting the old tags.

Commit the setup files before preparing a plan. Configure required PR checks and branch protections in your Git host; generating a pipeline does not configure those settings.

## Bootstrap and sandbox refresh

The experimental bootstrap creates an External Client App and an app-access-only
permission set, assigns that set to an existing integration user, then verifies
JWT authentication. It uses an existing, separate administrator connection:

```sh
sfci auth bootstrap --target preprod --admin-org preprod-admin \
  --username ci@example.com.preprod
```

Keys and credentials are saved in a private directory outside Git. The command
prints its path, not its contents. Transfer the generated variables to the
matching secured Bitbucket environment. Existing API/deployment permissions of
the integration user are required; bootstrap does not grant those rights.

After refreshing a sandbox, reconnect the administrator and rerun with
`--after-refresh`, using the same private bootstrap directory. The command
reuses that sandbox's key and configured client ID and verifies the login.
Salesforce may reject conflicting client credentials; the command stops on a
server rejection rather than claiming the environment is ready. Verify/update
the Bitbucket variables and explicitly set the baseline to the source commit
actually copied by the refresh. Authentication never guesses that commit.

This bootstrap has offline tests and official metadata resolution, but has not
been qualified against a live org. See [Bitbucket/JWT setup](docs/bitbucket-jwt.md).
To add an integration stage or change promotion links, edit `sfci.yml`, then run
`sfci pipeline --ci bitbucket`; existing pipeline files remain untouched and a
reviewable example is generated.

## Deliver

| Command | Purpose |
| --- | --- |
| `sfci check --target preprod` | Snapshot committed sources, calculate the cumulative delta, and validate it in the configured org. |
| `sfci plan --target preprod` | Prepare and inspect a plan without submitting a metadata validation. |
| `sfci deploy --target preprod --push` | Deploy the selected trunk version and publish its successful receipt. |
| `sfci release --from preprod --output .sfci/release.json` | Freeze the last successful sfci deployment from the configured source org. |
| `sfci deploy --target prod --release .sfci/release.json --push` | Validate and deploy that exact version using the production baseline. |
| `sfci status` | Show baselines and unfinished operations recorded locally or on origin. |
| `sfci resume --target preprod --push` | Reconcile a preserved deployment operation without submitting it again. |

Use `--yes` to confirm mutations in CI, `--json` for a structured result, and `--verbose` for diagnostics. Metadata deletion requires a separate `--allow-destructive` flag. `--mode full` deploys the configured source directories while retaining explicit Git-derived deletions; it does not purge unknown org metadata.

With an `origin`, mutations coordinate and publish receipts there by default; `--push` makes this explicit. Use `--no-push` only for isolated local operation. All runners delivering to an org must share one coordinator and origin.

Plans live under `.sfci/plans/<id>/`. Each plan contains its own committed source snapshot, manifests, org identity, configuration fingerprint, and file hashes. Keep the **whole directory**, not just `plan.json`, when moving it between CI steps.

Salesforce commands run in disposable copies so their tracking caches cannot change the immutable snapshot. sfci uses its Git receipts as the delivery baseline; native source-tracking conflicts are ignored in these fresh workspaces. This does not add manual-org drift detection.

```sh
sfci check --target preprod --plan .sfci/plans/<id>/plan.json
sfci deploy --target preprod --plan .sfci/plans/<id>/plan.json --push
```

The production path uses a successful production validation followed by Salesforce Quick Deploy. A UAT validation is never reused for production. Tests default to `RunLocalTests`; `NoTestRun` is rejected for actual production orgs.

`sfci check --target prod --plan <path> --refresh` reruns validation after an external deployment or package installation. The cached result is bound to the plan and expires conservatively after nine days; Salesforce determines actual Quick Deploy eligibility.

## What is recorded

Annotated tags under `sfci/<environment>/` contain structured deployment receipts: org ID, source commit, predecessor, sequence, plan ID, Salesforce job ID, and completion time. Tags are created only after confirmed success. Receipt order uses a sequence rather than the timestamp of an arbitrary Git tag; conflicting sequences stop the operation.

For example, if UAT is on A and deployment B fails, the next plan for C starts at **A**, not B or `HEAD^`. Production has its own independent baseline.

## Recovery and operating limits

- Serialize Salesforce checks and deployments for the same org in your CI. With publication enabled, an atomic Git checkpoint under `sfci-pending/<org-id>` blocks another cooperating runner before metadata submission. Setup changes, other repositories, and other deployment tools remain outside this coordination.
- Keep `.sfci/operations/` and its exact plan directory as protected CI artifacts, including on failure. Fresh runners discover the pending checkpoint on origin, but still need the immutable plan to resume. The GitHub template restores artifacts from an explicitly selected run; it never guesses the latest artifact.
- After a pipeline interruption, use `status`, restore the original plan, and `resume`. A lost artifact or submission without a confirmed job ID requires operator reconciliation. A baseline-publication checkpoint without an operation also requires verifying the receipt and org before clearing it. Do not remove a checkpoint merely to unblock another deployment.
- A receipt describes the last deployment known to sfci. It does not detect manual changes in an org. Reconcile those changes, or a sandbox refresh, before resetting a verified baseline.
- Automatic metadata dependency discovery is limited to Git Delta's behavior. A successful delta validation does not prove every external dependency or future full deployment will work.
- Source snapshots currently reject symbolic links, submodules and Git LFS pointers. Deployments do not run Apex/data migrations, activate feature flags, or promise automatic rollback.
- The first image targets Linux x86-64. Nix development and CLI builds support Apple Silicon macOS and the declared Linux platforms; image builds run on Linux.

Read the [Salesforce trunk-based delivery guide](docs/trunk-based.md) for metadata dependencies, profiles, feature flags, schema evolution, squash merges, and org refreshes. Use the [dedicated-sandbox acceptance recipe](docs/acceptance.md) to qualify the workflow on your project before production.

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
