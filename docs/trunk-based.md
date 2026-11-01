# Trunk-based Salesforce delivery

`main` is the integration line. Short-lived branches use ordinary Git commits;
the CI validates a merge candidate, deploys the current trunk to UAT, then promotes
a frozen commit already delivered to UAT. Salesforce orgs remain mutable systems,
so Git history alone cannot establish their current contents.

## The delivery contract

- A baseline is the last successful receipt for **that environment and org ID**.
  If UAT is on A, B fails, and C is next, the plan is A → C. Production uses its
  own baseline even when UAT has received several newer commits.
- A plan binds a committed snapshot, the effective manifests, configuration,
  toolchain, org identity, and baseline. Review its deletions before applying it.
- `--mode full` includes the managed source scope; it does not purge everything
  else in the org. Scope changes in `.forceignore`, `packageDirectories`, or API
  version require full mode rather than silently skipping newly managed files.
- A receipt is delivery evidence, not a retrieve comparison or business sign-off.
  Setting a baseline asserts a verified correspondence; it does not repair an org.

## Salesforce frictions to plan for

| Friction | Practical rule |
| --- | --- |
| Metadata dependencies | Git Delta identifies changes and deletions between source states; it is not a complete dependency resolver. Include related fields, record types, translations, permissions, and installed-package prerequisites when needed. Both end states must remain deployable. A green delta is not proof that a future full deployment works. [SGD guidance](https://github.com/scolladon/sfdx-git-delta#is-sgd-for-you) |
| Shared-org writes | Use one delivery coordinator per actual org, including aliases that identify the same org. CI serialization and `--push` checkpoints coordinate cooperating sfci runs sharing one origin; they do not lock Setup, package installers, other repositories, or other deployment tools. |
| Manual drift | An administrator can change a component after its Git receipt. sfci currently does not detect that drift. Reconcile the change into Git or explicitly restore the managed state before continuing; a successful validation does not establish absence of drift. |
| Profiles and permissions | Profile retrieval depends on the other metadata requested and on source tracking. Review a retrieve's scope before committing removals. Prefer focused permission sets where appropriate, and retrieve referenced components with permission metadata. sfci does not normalize profiles for you. [Salesforce profile guidance](https://developer.salesforce.com/docs/platform/sfdx-dev/guide/sfdx-dev-source-tracking-source-tracking-profiles.html), [Metadata API retrieval guidance](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf) |
| Flow deletions | Deleting an unversioned Flow file does not safely delete its org versions. This alpha blocks Flow and FlowDefinition destructive entries. Plan retirement/version cleanup separately, then establish the corresponding verified baseline; do not work around the block by editing a plan. [SGD Flow guidance](https://github.com/scolladon/sfdx-git-delta#handle-flow-deletion) |
| Apex tests | UAT's test results do not replace Production's. sfci defaults to `RunLocalTests` and rejects `NoTestRun` for an actual production org. Salesforce enforces deployment coverage: local/all-test coverage requires at least 75% overall with some trigger coverage; specified-test coverage is per deployed class/trigger. sfci does not currently expose specified-test selection. [Salesforce test levels](https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_project_deploy_start.html), [coverage eligibility](https://help.salesforce.com/s/articleView?id=sf.deploy_monitoring.htm&language=en_US&type=5) |
| Quick Deploy | A successful validation must belong to the same target, pass tests and coverage, remain within Salesforce's eligibility window, and remain eligible after other deployments. Salesforce documents a ten-day window; an intervening deployment or package installation invalidates previous validations. Use `check --refresh` after relevant external writes. The server remains authoritative. [Salesforce Quick Deploy requirements](https://help.salesforce.com/s/articleView?id=sf.deploy_monitoring.htm&language=en_US&type=5) |
| Squash and rebase | The feature SHA, a CI-generated merge SHA, and the final squash SHA can differ. Validate the actual integration candidate and replan the resulting trunk commit. Do not attach a feature's validation to another commit merely because the PR was green. sfci rejects stale candidates and obsolete automatic trunk deployments. |
| Sandbox refresh | Reauthenticate, verify the org ID and the source snapshot copied by the refresh, then record a new verified baseline. An unchanged alias does not mean an unchanged org. Old plans must not be reused. |

Salesforce itself queues metadata deployments, but that queue is not a release
coordination mechanism: another operation can alter assumptions while a candidate
waits. Keep the Git/CI coordinator and inspect other pending operations when
investigating a deployment. [Salesforce deployment monitoring](https://help.salesforce.com/s/articleView?id=sf.deploy_monitoring.htm&language=en_US&type=5)

## Ship incomplete work safely

Merge small compatible increments. A feature flag must guard every relevant
entry point: Apex, record-triggered Flow, batch/scheduled work, integrations, and
UI. A hidden button alone does not disable the underlying behavior. Test both
states and keep the default safe for existing users.

Use expand–migrate–contract for structural changes:

1. Add compatible fields/interfaces and deploy code that can tolerate both forms.
2. Run an explicit, repeatable data migration and verify its result.
3. Enable the feature for the intended users.
4. Remove obsolete readers/writers and metadata in a later reviewed release.

Flags do not hide schema changes or make destructive migrations reversible.
Permission-set assignments are separate user records, not simply the permission
set definition. Custom metadata records may be deployable metadata; ordinary
business/reference data still needs its own migration process. sfci currently
does not run migrations, assign users, or activate flags. [PermissionSetAssignment
reference](https://developer.salesforce.com/docs/platform/field-reference/references/field-reference/salesforce-field-reference-permissionsetassignment.html)

## Keep failures recoverable

With `--push`, sfci publishes an in-flight checkpoint under
`refs/tags/sfci-pending/<first-15-org-id-characters>` before submitting a deployment. It prevents
another cooperating checkout from silently continuing while the outcome is
unknown. The checkpoint contains operation identity, not the complete source plan.

Keep the exact `.sfci/plans/` and `.sfci/operations/` artifacts from the failed
run. In a fresh workspace, restore them and use:

```sh
sfci status --target uat
sfci resume --target uat --yes --push
```

`resume` follows a known job or finishes publishing its receipt; it does not submit
another deployment. A missing plan or an ambiguous submission without a confirmed
job ID requires operator reconciliation. Do not delete checkpoints or invent a
baseline to make the pipeline green. See the [sandbox acceptance recipe](acceptance.md).

This guidance describes the current alpha and primary Salesforce/SGD documentation
reviewed on 1 November 2026. It is not evidence of live-org acceptance.
