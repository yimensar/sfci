import { resolve } from "node:path";
import { Command, CommanderError, Option } from "commander";
import {
  CliError,
  confirmAction,
  output,
  reportError,
  withProgress,
  type OutputOptions,
} from "./ui.js";
import { VERSION } from "./version.js";

interface GlobalOptions {
  cwd: string;
  json: boolean;
  verbose: boolean;
}
interface TargetOptions {
  target: string;
}
interface PlanOptions extends TargetOptions {
  ref: string;
  mode: "delta" | "full";
}
interface CheckOptions extends PlanOptions {
  plan?: string;
  refresh: boolean;
}
interface DeployOptions extends TargetOptions {
  ref: string;
  mode: "delta" | "full";
  plan?: string;
  release?: string;
  yes: boolean;
  allowDestructive: boolean;
  push?: boolean;
}

const program = new Command()
  .name("sfci")
  .description("Fast, guided Salesforce delivery.")
  .version(VERSION)
  .option("--cwd <directory>", "Salesforce project directory", ".")
  .option("--json", "write a structured result to stdout", false)
  .option("--verbose", "show diagnostic details on stderr", false)
  .showHelpAfterError()
  .showSuggestionAfterError()
  .exitOverride()
  .configureOutput({
    writeOut: (text) => process.stdout.write(text),
    writeErr: () => {},
  });

const context = (): { cwd: string; output: OutputOptions } => {
  const options = program.opts<GlobalOptions>();
  return {
    cwd: resolve(options.cwd),
    output: { json: options.json, verbose: options.verbose },
  };
};

program
  .command("init")
  .description(
    "Set up sfci and a CI pipeline without overwriting existing files",
  )
  .addOption(
    new Option("--ci <provider>", "CI provider").choices([
      "github",
      "bitbucket",
    ]),
  )
  .option(
    "--environment <name:type[:alias]>",
    "named sandbox/production environment (repeatable)",
    (value: string, values: string[]) => [...values, value],
    [],
  )
  .option(
    "--promote <source:target>",
    "promote a frozen release between environments (repeatable)",
    (value: string, values: string[]) => [...values, value],
    [],
  )
  .option("--trunk <branch>", "trunk branch (default: main)")
  .action(
    async (options: {
      ci?: string;
      environment?: string[];
      promote?: string[];
      trunk?: string;
    }) => {
      const ctx = context();
      const { initialize } = await import("./commands/init.js");
      output(
        "init",
        await initialize(
          {
            cwd: ctx.cwd,
            ...(options.ci ? { ci: options.ci } : {}),
            ...(options.trunk ? { trunk: options.trunk } : {}),
            environments: options.environment ?? [],
            promotions: options.promote ?? [],
          },
          ctx.output,
        ),
        ctx.output,
      );
    },
  );

program
  .command("pipeline")
  .description(
    "Generate a pipeline from sfci.yml without overwriting existing files",
  )
  .addOption(
    new Option("--ci <provider>", "CI provider")
      .choices(["bitbucket", "github"])
      .makeOptionMandatory(),
  )
  .action(async (options: { ci: "bitbucket" | "github" }) => {
    const ctx = context();
    const { generatePipeline } = await import("./commands/init.js");
    output(
      "init",
      await generatePipeline({ cwd: ctx.cwd, ci: options.ci }),
      ctx.output,
    );
  });

program
  .command("doctor")
  .description("Check the project, tools, and optional Salesforce connection")
  .option("--target <environment>", "also check this Salesforce org")
  .action(async (options: { target?: string }) => {
    const ctx = context();
    const { doctor } = await import("./core/index.js");
    const result = await withProgress(
      "Checking project and tools",
      ctx.output,
      () => doctor({ cwd: ctx.cwd, ...options }),
    );
    output("doctor", result, ctx.output);
    if (!result.ok) process.exitCode = 1;
  });

const authCommand = program
  .command("auth")
  .description("Connect an org with JWT using the bundled Salesforce CLI")
  .option("--target <environment>", "configured environment")
  .option(
    "--client-id <id>",
    "Salesforce application client ID (or SF_CLIENT_ID)",
  )
  .option(
    "--username <username>",
    "Salesforce integration user (or SF_USERNAME)",
  )
  .option(
    "--jwt-key-file <path>",
    "RSA private key file (or SF_JWT_KEY_FILE / SF_JWT_KEY_B64)",
  )
  .option(
    "--instance-url <url>",
    "HTTPS login/My Domain URL (or SF_INSTANCE_URL)",
  )
  .action(
    async (options: {
      target: string;
      clientId?: string;
      username?: string;
      jwtKeyFile?: string;
      instanceUrl?: string;
    }) => {
      if (!options.target)
        throw new CliError("Specify --target <environment>.");
      const ctx = context();
      const { authenticate } = await import("./commands/auth.js");
      output(
        "auth",
        await withProgress(
          "Authenticating with Salesforce JWT",
          ctx.output,
          () => authenticate({ cwd: ctx.cwd, ...options }),
        ),
        ctx.output,
      );
    },
  );

authCommand
  .command("bootstrap")
  .description(
    "Create or restore a JWT External Client App using an admin connection (experimental)",
  )
  .requiredOption(
    "--admin-org <alias>",
    "existing administrator connection, separate from the delivery alias",
  )
  .option("--output <directory>", "private credential directory outside Git")
  .option("--app-name <name>", "External Client App API name")
  .option(
    "--after-refresh",
    "accept the changed org ID of a refreshed sandbox",
    false,
  )
  .option(
    "-y, --yes",
    "confirm app creation and app-access authorization",
    false,
  )
  .addHelpText(
    "after",
    "\nRequired auth options: --target <environment> --username <integration-user>\nExample: sfci auth bootstrap --target preprod --username ci@example.com.preprod --admin-org preprod-admin\nPrivate keys are stored outside Git. Qualify bootstrap on a dedicated sandbox first.",
  )
  .action(
    async (options: {
      target: string;
      adminOrg: string;
      username: string;
      output?: string;
      appName?: string;
      afterRefresh: boolean;
      yes: boolean;
    }) => {
      const ctx = context();
      const shared = authCommand.opts<{ target?: string; username?: string }>();
      if (!shared.target || !shared.username)
        throw new CliError("Bootstrap requires --target and --username.");
      const settings = {
        ...options,
        target: shared.target,
        username: shared.username,
      };
      const { bootstrap } = await import("./commands/bootstrap.js");
      output(
        "bootstrap",
        await bootstrap({
          ...settings,
          cwd: ctx.cwd,
          approve: (message) =>
            confirmAction(message, options.yes, ctx.output),
        }),
        ctx.output,
      );
    },
  );

const planCommand = program
  .command("plan")
  .description("Prepare an immutable deployment plan from committed sources");
addPlanOptions(planCommand).action(async (options: PlanOptions) => {
  const ctx = context();
  const { createPlan } = await import("./core/index.js");
  const plan = await withProgress("Preparing deployment plan", ctx.output, () =>
    createPlan({ cwd: ctx.cwd, ...options }),
  );
  output("plan", plan, ctx.output);
});

const checkCommand = program
  .command("check")
  .description(
    "Validate a deployment plan in the target org without deploying metadata",
  );
addPlanOptions(checkCommand)
  .option("--plan <path>", "validate an existing plan instead of preparing one")
  .option(
    "--refresh",
    "run Salesforce validation again instead of reusing its result",
    false,
  )
  .action(async (options: CheckOptions) => {
    const ctx = context();
    const core = await import("./core/index.js");
    const plan = options.plan
      ? await core.loadPlan(resolve(ctx.cwd, options.plan))
      : await withProgress("Preparing deployment plan", ctx.output, () =>
          core.createPlan({ cwd: ctx.cwd, ...planArguments(options) }),
        );
    assertTarget(plan.target, options.target);
    const validation = await withProgress(
      "Validating Salesforce changes",
      ctx.output,
      () =>
        core.validatePlan({
          cwd: ctx.cwd,
          planPath: plan.path,
          target: options.target,
          refresh: options.refresh,
        }),
    );
    output("check", { plan, validation }, ctx.output);
  });

program
  .command("deploy")
  .description(
    "Deploy committed sources or an approved release and record a receipt",
  )
  .requiredOption("--target <environment>", "configured environment")
  .option("--ref <commit>", "commit to deploy", "HEAD")
  .addOption(
    new Option("--mode <mode>", "metadata scope")
      .choices(["delta", "full"])
      .default("delta"),
  )
  .option("--plan <path>", "apply an existing immutable plan")
  .option("--release <path>", "deploy an immutable release descriptor")
  .option("-y, --yes", "confirm the selected target without prompting", false)
  .option(
    "--allow-destructive",
    "explicitly permit planned metadata deletions",
    false,
  )
  .option(
    "--push",
    "publish coordination and receipts to origin (default with origin)",
  )
  .option("--no-push", "keep receipts local for isolated use")
  .action(async (options: DeployOptions) => {
    const ctx = context();
    if (options.plan && options.release)
      throw new CliError("Choose either --plan or --release.");
    const core = await import("./core/index.js");
    if (options.plan) {
      const plan = await core.loadPlan(resolve(ctx.cwd, options.plan));
      assertTarget(plan.target, options.target);
      await confirmAction(
        `Deploy ${plan.to.slice(0, 12)} to ${options.target} (${plan.org})?`,
        options.yes,
        ctx.output,
      );
      const receipt = await withProgress(
        "Deploying Salesforce changes",
        ctx.output,
        () =>
          core.applyPlan({
            cwd: ctx.cwd,
            planPath: plan.path,
            target: options.target,
            allowDestructive: options.allowDestructive,
            ...(options.push !== undefined ? { push: options.push } : {}),
          }),
      );
      output("deploy", receipt, ctx.output);
    } else {
      await confirmAction(
        `Deploy to ${options.target}?`,
        options.yes,
        ctx.output,
      );
      const receipt = await withProgress(
        "Deploying Salesforce changes",
        ctx.output,
        () =>
          core.deploy({
            cwd: ctx.cwd,
            target: options.target,
            ref: options.ref,
            mode: options.mode,
            ...(options.release
              ? { releasePath: resolve(ctx.cwd, options.release) }
              : {}),
            allowDestructive: options.allowDestructive,
            ...(options.push !== undefined ? { push: options.push } : {}),
          }),
      );
      output("deploy", receipt, ctx.output);
    }
  });

program
  .command("release")
  .description("Freeze the last successful deployment of an environment")
  .requiredOption(
    "--from <environment>",
    "environment already used for acceptance testing",
  )
  .requiredOption("--output <path>", "new release descriptor file")
  .action(async (options: { from: string; output: string }) => {
    const ctx = context();
    const { createRelease } = await import("./core/index.js");
    const path = resolve(ctx.cwd, options.output);
    const release = await createRelease({
      cwd: ctx.cwd,
      from: options.from,
      output: path,
    });
    output("release", { ...release, path }, ctx.output);
  });

program
  .command("status")
  .description("Show delivery baselines and operations needing attention")
  .option("--target <environment>", "show one configured environment")
  .action(async (options: { target?: string }) => {
    const ctx = context();
    const { status } = await import("./core/index.js");
    output("status", await status({ cwd: ctx.cwd, ...options }), ctx.output);
  });

program
  .command("resume")
  .description(
    "Reconcile a pending operation without submitting another deployment",
  )
  .requiredOption("--target <environment>", "configured environment")
  .option("-y, --yes", "confirm reconciliation without prompting", false)
  .option(
    "--push",
    "publish coordination and receipts to origin (default with origin)",
  )
  .option("--no-push", "keep receipts local for isolated use")
  .action(async (options: TargetOptions & { yes: boolean; push?: boolean }) => {
    const ctx = context();
    await confirmAction(
      `Reconcile the pending operation for ${options.target}?`,
      options.yes,
      ctx.output,
    );
    const { resume } = await import("./core/index.js");
    output(
      "resume",
      await withProgress("Reconciling Salesforce operation", ctx.output, () =>
        resume({
          cwd: ctx.cwd,
          target: options.target,
          ...(options.push !== undefined ? { push: options.push } : {}),
        }),
      ),
      ctx.output,
    );
  });

program
  .command("baseline")
  .description("Record the known Git state of an existing Salesforce org")
  .command("set")
  .description(
    "Record a verified baseline; does not deploy or compare metadata",
  )
  .requiredOption("--target <environment>", "configured environment")
  .requiredOption("--commit <commit>", "commit known to match the target org")
  .option("-y, --yes", "confirm the verified baseline without prompting", false)
  .option(
    "--push",
    "publish coordination and receipts to origin (default with origin)",
  )
  .option("--no-push", "keep receipts local for isolated use")
  .action(
    async (
      options: TargetOptions & { commit: string; yes: boolean; push?: boolean },
    ) => {
      const ctx = context();
      await confirmAction(
        `Record ${options.commit} as the verified state of ${options.target}? This does not compare Salesforce metadata.`,
        options.yes,
        ctx.output,
      );
      const { setBaseline } = await import("./core/index.js");
      output(
        "baseline",
        await withProgress("Recording verified baseline", ctx.output, () =>
          setBaseline({
            cwd: ctx.cwd,
            target: options.target,
            commit: options.commit,
            ...(options.push !== undefined ? { push: options.push } : {}),
          }),
        ),
        ctx.output,
      );
    },
  );

program.addHelpText(
  "after",
  "\nStart with sfci init. Use --json for automation and --yes for confirmed CI mutations.\n",
);

function addPlanOptions(command: Command): Command {
  return command
    .requiredOption("--target <environment>", "configured environment")
    .option("--ref <commit>", "committed source version", "HEAD")
    .addOption(
      new Option("--mode <mode>", "metadata scope")
        .choices(["delta", "full"])
        .default("delta"),
    );
}

function planArguments(options: PlanOptions): PlanOptions {
  return { target: options.target, ref: options.ref, mode: options.mode };
}

function assertTarget(actual: string, requested: string): void {
  if (actual !== requested)
    throw new CliError(
      `This plan targets ${actual}, not ${requested}.`,
      "Review the plan and select the matching --target.",
    );
}

try {
  if (process.argv.length === 2) program.help();
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    const options = context().output;
    const normalized =
      error instanceof CommanderError
        ? new CliError(
            error.message.replace(/^error: /, ""),
            "Run sfci --help or sfci <command> --help for usage.",
          )
        : error;
    reportError(normalized, options);
    process.exitCode =
      error instanceof CliError && error.code === "CANCELLED" ? 130 : 1;
  }
}
