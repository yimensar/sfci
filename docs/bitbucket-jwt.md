# Named environments, Bitbucket and JWT

Environment names and promotion paths belong to your project. Each environment
has an `org` alias, a `type` (`sandbox` or `production`) and optionally a
`promoteFrom` source. Existing configurations without `type` still work for
ordinary delivery; add it before using bootstrap. Actual org type is checked
against the declaration.
For regenerated pipelines, only explicitly typed sandbox roots deploy automatically;
an older untyped root uses a manually started pipeline until its type is declared.

## Configure your path

Run `sfci init` interactively, or supply repeatable options:

```sh
sfci init --ci bitbucket \
  --environment integration:sandbox:my-int \
  --environment preprod:sandbox:my-preprod \
  --environment prod:production:my-prod \
  --promote integration:preprod \
  --promote preprod:prod
```

Omit a stage you do not use. `--environment qa:sandbox` defaults its alias to `qa`.
The first stage is validated on PRs and deployed from the current trunk. Each
promoted stage receives its own custom pipeline (`promote-preprod`, `promote-prod`)
that freezes a successful source receipt and waits before the target deployment.
A direct production target uses a manually started custom pipeline rather than an
automatic deployment on push. Independent root stages are also supported.

```yaml
trunk: main
environments:
  integration:
    type: sandbox
    org: my-int
    tests: RunLocalTests
  preprod:
    type: sandbox
    org: my-preprod
    tests: RunLocalTests
    promoteFrom: integration
  prod:
    type: production
    org: my-prod
    tests: RunLocalTests
    promoteFrom: preprod
```

After editing the configuration, use `sfci pipeline --ci bitbucket`. It preserves
an existing pipeline and writes `sfci.bitbucket.example.yml` for review. Rename or
review an old example before generating another. Commit your setup with `[skip ci]`,
push trunk, and record verified baselines before the first normal run. A new empty
scaffold is a valid baseline only for a genuinely empty managed application scope.

## Bootstrap an External Client App (experimental)

Bootstrap uses an existing administrator connection; it cannot authenticate to an
unknown org without initial authorization. Keep that alias separate from the
configured delivery alias, which will be authenticated as the integration user.
An existing administrator connection made with Salesforce CLI can be reused.

The integration user must already exist and possess the API/deployment rights
needed by your project. Bootstrap creates a dedicated, empty app-access permission
set, authorizes that set for JWT, and assigns it to this user. It does not grant
System Administrator, business permissions or deployment rights, or relax IP rules.

```sh
sfci auth bootstrap --target preprod \
  --admin-org preprod-admin \
  --username ci@example.com.preprod
```

The command identifies the org and user, generates an RSA-3072 key and one-year
self-signed public certificate using Node/OpenSSL, prepares the metadata, and asks
for confirmation showing the real org ID and certificate fingerprint. `--yes`
allows a deliberately confirmed noninteractive run. It then creates the External
Client App through Salesforce metadata deployment (API 68.0), assigns app access and verifies
JWT login using the official CLI.

OpenSSL is included in the Nix package; npm users must provide it. Generated keys,
certificate, bootstrap state and `bitbucket-variables.json` live in a private
`~/.local/share/sfci/auth/<project-id>/<target>/` directory, outside Git. Override
with `--output <private-directory>` for an established secure location. Directory
and secret-file permissions are restricted. Tokens and private values are never
returned by the command. Protect/back up this directory in your secure store;
base64 transport encoding is not encryption. Do not put it in CI artifacts.

App names default to `Sfci_<environment>`. `--app-name` selects another API name.
An existing unrelated app or permission-set name is not overwritten. Subsequent
runs reuse their private state. A missing original key stops the command rather
than silently rotating an active identity. Bootstrap does not replace permissions
on an existing access set. A partially configured existing set requiring a new
assignment must be reviewed and assigned explicitly before retrying.

**The bootstrap has offline tests and metadata resolution checks, not live-org
qualification.** Salesforce may require propagation time or reject metadata or
client-credential conflicts. A rejected verification preserves private state for
retry and does not claim the environment is ready. Validate on a dedicated sandbox
before using bootstrap in production. Ordinary JWT authentication remains separate.

## Configure Bitbucket variables

Create Bitbucket environments matching your configuration names, with appropriate
Test/Staging/Production categories. For each environment configure:

| Variable | Value |
| --- | --- |
| `SF_CLIENT_ID` | Application consumer key/client ID. Existing `SFDX_CLIENT_ID` is accepted. |
| `SF_USERNAME` | Authorized integration user. |
| `SF_INSTANCE_URL` | HTTPS org login/My Domain URL. |
| `SF_JWT_KEY_B64` | RSA private key in base64; mark it **Secured**. |

After a successful bootstrap, the private `bitbucket-variables.json` contains these
values for transfer to your secured environment settings. Bootstrap does not write
to Bitbucket or create its environments. Keys for different orgs stay separate.
The generated pipeline calls `sfci auth --target <name>` with its environment's
variables. `--jwt-key-file` / `SF_JWT_KEY_FILE` also support a caller-owned key file.
Salesforce CLI stores the key path and rereads it to renew an expired session.
A decoded base64 key is retained in a private temporary directory after successful
login; the command returns its path, never its contents. Keep it for the entire CI
job, then let the ephemeral runner remove it. Self-hosted runners must explicitly
remove that generated file/directory after their final Salesforce command.
Failed authentication removes its
temporary key. Locally, prefer a stable caller-owned key file, since operating
system cleanup can remove temporary files. Existing authenticated aliases remain
reusable while their backing credentials are available.

Keep Bitbucket's preconfigured HTTP Git origin when it supplies the required
write access. Receipt and checkpoint publication requires creating `sfci/*` tags
and updating/deleting `sfci-pending/*` tags. Salesforce JWT does not authenticate Git.

## After a sandbox refresh

1. Reconnect/verify the administrator alias against the refreshed sandbox.
2. Restore the sandbox's original private bootstrap directory from your secure store.
3. Run bootstrap with the same target/output and `--after-refresh`.
4. Verify the resulting Bitbucket variable values and JWT login.
5. Verify which source commit the refresh actually copied, then explicitly record
   that sandbox's new deployment baseline. Do not infer it from a successful login.

```sh
sfci auth bootstrap --target preprod --admin-org preprod-admin \
  --username ci@example.com.preprod --after-refresh
sfci baseline set --target preprod --commit <verified-source-commit> --push
```

`--after-refresh` is sandbox-only. It accepts its changed org ID, reuses its key and
requested client ID, and recreates/reapplies its own app. It never changes production
credentials, deletes pending deployments or guesses an org baseline. If Salesforce
rejects a client ID conflict, stop and reconcile the identity before updating CI.

Sources: [Salesforce ECA setup](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-auth-eca.html),
[Metadata API](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf),
[JWT CLI](https://github.com/salesforcecli/plugin-auth#sf-org-login-jwt),
[Bitbucket environment scoping](https://support.atlassian.com/bitbucket-cloud/docs/step-options/#Environment),
[push-back](https://support.atlassian.com/bitbucket-cloud/docs/push-back-to-your-repository/).
Hardis' [auth bootstrap](https://sfdx-hardis.cloudity.com/hardis/project/configure/auth/)
was studied as a reference: it automates the ECA/certificate and supports encrypted
repository or external storage. sfci's implementation uses official metadata fields,
Node, OpenSSL and Salesforce CLI, with private material outside the repository.
