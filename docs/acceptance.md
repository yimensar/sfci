# Dedicated-sandbox acceptance

This is a manual recipe, **not a record of tests already run**. Use a disposable
Salesforce sandbox and a disposable Git origin. Never substitute a production
alias. Keep the CLI/image version, org ID, commit, plan ID, job IDs, receipts, and
the observed outcome for each case. Authentication URLs and tokens are not evidence.

## Prepare the fixture

Have the built sfci runtime and its bundled `sf` command on `PATH`. Create a local
test repository and bare origin; this avoids changing an existing delivery repo:

```sh
SFCI_ACCEPTANCE_ROOT="$(mktemp -d)"
git init --bare "$SFCI_ACCEPTANCE_ROOT/origin.git"
git init -b main "$SFCI_ACCEPTANCE_ROOT/work"
cd "$SFCI_ACCEPTANCE_ROOT/work"
git remote add origin "$SFCI_ACCEPTANCE_ROOT/origin.git"
```

Create a minimal Salesforce DX project using an API version supported by the
sandbox. Set `.gitignore` to include `.sfci/` and configure:

```yaml
# sfci.yml
trunk: main
environments:
  acceptance:
    org: sfci-acceptance
    tests: RunLocalTests
```

Put `SfciAcceptance.cls` and `SfciAcceptanceTest.cls` in the configured classes
directory, each with its normal `ApexClass` metadata file:

```apex
public class SfciAcceptance {
    public static Integer value() { return 1; }
}
```

```apex
@IsTest
private class SfciAcceptanceTest {
    @IsTest static void valueIsExpected() {
        System.assertEquals(1, SfciAcceptance.value());
    }
}
```

Authenticate, then query `Organization` and confirm `IsSandbox = true` before
performing any deployment. Do not capture an `org display --verbose` response.

```sh
sfci auth --target acceptance --instance-url https://test.salesforce.com
sf data query --target-org sfci-acceptance \
  --query 'SELECT Id, IsSandbox FROM Organization' --json
git add .
git commit -m 'Acceptance baseline A'
git push -u origin main
sf project deploy start --target-org sfci-acceptance \
  --source-dir force-app --test-level RunLocalTests
```

After that native deployment is confirmed successful and the fixture matches A:

```sh
sfci baseline set --target acceptance --commit HEAD --yes --push
sfci doctor --target acceptance
```

## Exercise the delivery path

For every source change below, commit it and push `main` before deploying.

| Case | Action and required observation |
| --- | --- |
| Dry-run | Change the return value and its test expectation to `2` in B. Run `sfci check --target acceptance --json`. Expect success, an unchanged org value/receipt, and a plan for A → B. |
| Immutable plan | Copy the plan directory, change a snapshotted class byte, and apply the copy with `--plan .../plan.json`. Expect a plan-integrity error before a metadata submission. Apply the untouched original plan; expect B in the org and one successful receipt. |
| Cumulative recovery | In C change the return value to `3` but leave the test expecting `2`. Deployment must fail and retain B as the baseline. Reconcile any pending operation using its actual job result. Fix the test in D. The next plan must be B → D, including both changes. |
| Scope change | Change `.forceignore` or add an existing package directory to `sfdx-project.json`. Delta planning must request `--mode full`; inspect that full plan before validating/applying it. |
| Stale plan | Prepare a plan, then advance the environment using another successful deployment. Applying the old plan must fail before another submission. |
| Shared checkout | While a pushed deployment has a remote pending checkpoint, try a second checkout against the same org/origin. It must report the pending operation rather than submit a second job. |
| Deletion | Add and deploy an unused fixture component, then delete it in Git. Deployment must require `--allow-destructive`. Use only this disposable component; review references first. |
| Flow retirement | Commit a Flow-file deletion in a separate fixture change. Planning must report the alpha's unsupported versioned-Flow deletion, without submitting a destructive job. |
| Drift/refresh | Make a harmless manual fixture change and confirm that a Git receipt alone does not report drift. If refreshing this disposable sandbox, verify the new identity/state and record the corresponding baseline; the old plan must be rejected. |

If a fixture deployment fails without a confirmed rollback, inspect its actual
Salesforce outcome before proceeding. A red CLI exit does not prove that no
component changed. These observations are deployment acceptance, not business UAT.

## Kill the client after Salesforce accepted a job

Use a valid new fixture commit and enough test work to observe a running job.
Start the deployment in one terminal, retaining its process ID:

```sh
sfci deploy --target acceptance --yes --push &
SFCI_ACCEPTANCE_PID=$!
```

Wait until `.sfci/operations/acceptance.json` contains phase `running` and a
confirmed `jobId`; record that ID. Then terminate **that local client**:

```sh
kill -KILL "$SFCI_ACCEPTANCE_PID"
```

Do not cancel or resubmit the Salesforce job. Make a fresh clone, restore only
`.sfci/plans/` and `.sfci/operations/` from this exact run (not locks, workspaces,
or authentication files), and run `sfci resume --target acceptance --yes --push`.
Expect the same job ID, no second deployment in Salesforce Deployment Status,
one successful receipt, and removal of the remote pending checkpoint. If the job
finished before termination, this interruption case was not exercised.

A hard-killed runner can lose its plan before artifact upload. In that case, a
fresh checkout must see the remote pending checkpoint and refuse to guess; keep
it blocked until an operator reconciles the recorded job and source state.

## Fail only the receipt push

In the disposable bare origin, install an executable `hooks/pre-receive` hook
that rejects receipt tags while allowing the in-flight checkpoint updates:

```sh
cat > "$SFCI_ACCEPTANCE_ROOT/origin.git/hooks/pre-receive" <<'HOOK'
#!/bin/sh
while read old new ref; do
  case "$ref" in refs/tags/sfci/acceptance/*) exit 1 ;; esac
done
exit 0
HOOK
chmod +x "$SFCI_ACCEPTANCE_ROOT/origin.git/hooks/pre-receive"
```

Deploy a valid new fixture commit with `--yes --push`. Expect Salesforce success
followed by `RECEIPT_PENDING`: the remote receipt remains unchanged, a local
success/receipt may already exist, and the pending checkpoint remains. Remove
this test hook, then run `sfci resume --target acceptance --yes --push`.
Expect the original job/receipt to be recorded without redeploying. Preserve the
before/after `git ls-remote origin 'refs/tags/sfci*'` results and Salesforce job IDs.

## Optional promotion and production boundary

A second disposable sandbox can exercise `promoteFrom`, a frozen release, and
independent baselines. Freeze under `.sfci/release.json`, advance `main` and UAT,
then deliver the frozen version to the second sandbox; verify its source commit.

This does **not** test the actual-production code path: sfci selects production
validation/Quick Deploy from the real org type. Salesforce recommends sandbox
validation with `deploy start --dry-run --test-level RunLocalTests`, not
`deploy validate`. Production Apex/coverage and Quick Deploy acceptance therefore
remain a separate authorized release gate, never an automatic step in this recipe.
[Salesforce CLI validation guidance](https://github.com/salesforcecli/plugin-deploy-retrieve#sf-project-deploy-validate),
[Quick Deploy eligibility](https://help.salesforce.com/s/articleView?id=sf.deploy_monitoring.htm&language=en_US&type=5).
