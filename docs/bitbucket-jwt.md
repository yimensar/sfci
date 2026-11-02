# Bitbucket Pipelines with Salesforce JWT

Use a preproduction sandbox and a production org. In the generated configuration,
`uat` is the logical preproduction target; its alias can be named `myproject-preprod`.
CI uses JWT exclusively. Existing local Salesforce CLI connections remain reusable.

## Prepare Salesforce

For each environment, use a dedicated integration user and an OAuth application
that supports JWT bearer authentication. Configure its public certificate and
authorize that user. An External Client App is suitable for new setups; an existing
Connected App can be used when it supports the required flow.

Keep a separate RSA private key/certificate pair for each environment. Upload the
certificate to Salesforce; the private key belongs in the CI secret store. Obtain
the application's consumer key/client ID and the integration user's username.
No client secret or refresh-token authorization URL is needed by this flow.

Salesforce's official instructions cover [External Client App configuration](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-auth-eca.html)
and the [JWT login command](https://github.com/salesforcecli/plugin-auth#sf-org-login-jwt).

## Configure Bitbucket

Under **Repository settings → Pipelines → Deployments**, create environments named
`uat` and `production`. Add the same variable names with different values in each:

| Variable | Description |
| --- | --- |
| `SF_CLIENT_ID` | Salesforce application consumer key/client ID. |
| `SF_USERNAME` | Integration user authorized for that application. |
| `SF_INSTANCE_URL` | HTTPS login/My Domain URL, normally `https://test.salesforce.com` for the sandbox and `https://login.salesforce.com` for production. |
| `SF_JWT_KEY_B64` | Base64-encoded RSA PEM private key. Mark it **Secured**. |

`SFDX_CLIENT_ID` is accepted when migrating an existing pipeline; `SF_CLIENT_ID`
takes precedence when both are set. Scope all four values to their environment;
avoid repository/workspace variables carrying production credentials. The check
and release-freeze steps use `environment: uat` to access preproduction variables
without recording a deployment. Delivery steps use `deployment: uat` or
`deployment: production`.

Use a fresh key for a new setup. If a key is suspected compromised, replace its
certificate and revoke access before relying on it. Do not copy keys into this
repository, image, plan artifacts or the Nix store. Base64 is transport encoding,
not encryption. Restrict deployment permissions to your authorized branches/users.

See Atlassian's [environment variable scoping](https://support.atlassian.com/bitbucket-cloud/docs/step-options/#Environment)
and [secured variables](https://support.atlassian.com/bitbucket-cloud/docs/variables-and-secrets/).

The pipeline also needs Git write access to its origin for sfci receipts and
pending checkpoints. Allow creation/update/deletion of `sfci-pending/*` tags and
creation of `sfci/*` receipts. Keep Bitbucket's preconfigured HTTP origin when it
provides the required access. If your restrictions prevent that, configure a
suitable repository-scoped token or authorized SSH identity using Bitbucket's
[push-back guidance](https://support.atlassian.com/bitbucket-cloud/docs/push-back-to-your-repository/).
Salesforce JWT credentials do not authenticate Git operations.

## Initialize the project

Install the runtime, create a standard Salesforce project, and initialize Git:

```sh
nix profile add github:yimensar/sfci/v0.1.0-alpha.3
sf template generate project --name myproject --template standard
cd myproject
git init -b main
sfci init --ci bitbucket --uat myproject-preprod --production myproject-prod
```

An existing pipeline is preserved; review and merge `sfci.bitbucket.example.yml`
when one is generated. sfci never overwrites it.

Before the first delivery, authenticate and verify the orgs. With the appropriate
JWT variables in your local environment, or explicit command options:

```sh
sfci auth --target uat
sfci doctor --target uat
```

Before baselines exist, doctor reports their absence; verify its org ID and
sandbox/production type. Repeat for production with its own credentials.
An existing local Salesforce CLI connection can be used without authenticating again.

Commit the project setup with `[skip ci]`, then push `main` to your new Bitbucket
origin. Record the verified initial baseline for each org before the first normal
pipeline run. The initial scaffold can be that baseline only when its empty
managed source scope represents the application state of both orgs. Retrieve and
verify existing components first when adopting a populated project.

```sh
git add .
git commit -m 'chore: initialize Salesforce delivery [skip ci]'
# Add your Bitbucket origin, then push main before publishing receipt tags.
git push -u origin main
sfci baseline set --target uat --commit HEAD --push
sfci baseline set --target production --commit HEAD --push
```

With both baselines and the environment variables configured, the generated pipeline:

1. Validates pull requests against preproduction using JWT.
2. Deploys the current `main` to preproduction and records its receipt.
3. Runs `promote-production` on demand to freeze the last version delivered there.
4. Waits at its manual production step, then validates and deploys that frozen commit.

`sfci auth --target <environment>` delegates to the bundled `sf org login jwt`.
Explicit options `--client-id`, `--username`, `--instance-url` and `--jwt-key-file`
take precedence over environment variables. `SF_JWT_KEY_FILE` can reference a key
provided by your secret manager instead of using `SF_JWT_KEY_B64`.

Decoded keys are written under the system temporary directory with a private
directory and file permissions (`0700`/`0600`), then removed on success or error.
A caller-supplied key file is left untouched. `--json` returns only target, alias
and authentication method; Salesforce tokens are never included.

These templates and offline tests do not establish that your Salesforce app,
certificate/user authorization or Bitbucket permissions are correctly provisioned.
Run the [dedicated-sandbox acceptance recipe](acceptance.md) before production use.
