import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  X509Certificate,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { readConfig } from "../core/config.js";
import { execute } from "../core/process.js";
import { assertOrgType, identify, runtime } from "../core/salesforce.js";
import { hash, json, root, save } from "../core/storage.js";
import { SfciError, type TargetOptions } from "../core/types.js";
import { authenticate, validateInstanceUrl } from "./auth.js";

interface BootstrapOptions extends TargetOptions {
  adminOrg: string;
  username: string;
  output?: string;
  appName?: string;
  afterRefresh?: boolean;
  approve?: (message: string) => Promise<void>;
}
interface State {
  schemaVersion: 1;
  target: string;
  orgId: string;
  appName: string;
  clientId: string;
}
const quote = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
const xml = (type: string, fields: Record<string, string | boolean>) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<${type} xmlns="http://soap.sforce.com/2006/04/metadata">\n${Object.entries(
    fields,
  )
    .map(
      ([key, value]) =>
        `  <${key}>${String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;")}</${key}>`,
    )
    .join("\n")}\n</${type}>\n`;

export async function bootstrap(options: BootstrapOptions): Promise<{
  target: string;
  orgId: string;
  appName: string;
  clientId: string;
  certificateFingerprint: string;
  credentialsFile: string;
  afterRefresh: boolean;
}> {
  const cwd = await root(options.cwd);
  const env = (await readConfig(cwd)).environments[options.target];
  if (!env?.type)
    throw new SfciError(
      "Bootstrap needs an explicit sandbox/production type in sfci.yml.",
      undefined,
      "CONFIG",
    );
  if (options.adminOrg === env.org)
    throw new SfciError(
      "Use a separate administrator alias for bootstrap.",
      "The configured delivery alias is authenticated as the integration user after setup; keep your administrator alias separate.",
      "AUTH_CONFIG",
    );
  if (options.afterRefresh && env.type !== "sandbox")
    throw new SfciError(
      "--after-refresh is only available for sandbox environments.",
      undefined,
      "ORG_TYPE",
    );
  const appName =
    options.appName ?? `Sfci_${options.target.replaceAll("-", "_")}`;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(appName))
    throw new SfciError(
      "Use an application API name of at most 50 letters, digits or underscores.",
      undefined,
      "AUTH_CONFIG",
    );
  const sf = runtime(options);
  const org = await identify(options, options.adminOrg);
  assertOrgType(env, org);
  const display = await sf.sf(
    ["org", "display", "--target-org", options.adminOrg],
    cwd,
  );
  if (typeof display.instanceUrl !== "string")
    throw new SfciError("Salesforce did not return the org instance URL.");
  validateInstanceUrl(display.instanceUrl);
  const users = await sf.sf(
    [
      "data",
      "query",
      "--target-org",
      options.adminOrg,
      "--query",
      `SELECT Id, Email, IsActive FROM User WHERE Username = '${quote(options.username)}'`,
    ],
    cwd,
  );
  const user = (users.records as Record<string, unknown>[] | undefined)?.[0];
  if (!user?.IsActive || typeof user.Email !== "string")
    throw new SfciError(
      "The integration user must already exist and be active in this org.",
      "Bootstrap authorizes app usage; it does not grant API or deployment permissions.",
      "AUTH_CONFIG",
    );
  const output = resolve(
    options.output ??
      resolve(
        homedir(),
        ".local",
        "share",
        "sfci",
        "auth",
        hash(cwd).slice(0, 12),
        options.target,
      ),
  );
  const inside = relative(cwd, output);
  if (!inside.startsWith("../") && inside !== "..")
    throw new SfciError(
      "Credential storage must be outside the Git repository.",
      "Choose a private directory with --output.",
      "AUTH_CONFIG",
    );
  await mkdir(output, { recursive: true, mode: 0o700 });
  const directory = await lstat(output);
  if (
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    directory.mode & 0o077
  )
    throw new SfciError(
      "Credential storage must be a private directory (0700), without a symbolic link.",
    );
  const canonicalOutput = await realpath(output);
  const canonicalRoot = await realpath(cwd);
  const canonicalRelative = relative(canonicalRoot, canonicalOutput);
  const gitLocation = await execute(
    "git",
    ["-C", canonicalOutput, "rev-parse", "--is-inside-work-tree"],
    cwd,
  );
  if (
    (!canonicalRelative.startsWith("../") && canonicalRelative !== "..") ||
    (gitLocation.code === 0 && gitLocation.stdout.toString().trim() === "true")
  )
    throw new SfciError("Credential storage resolves inside a Git repository.");
  const stateFile = resolve(output, "bootstrap.json");
  let createdState = false;
  let state: State;
  try {
    const info = await lstat(stateFile);
    if (!info.isFile() || info.mode & 0o077)
      throw new SfciError(
        "Bootstrap state must be a private regular file (0600).",
      );
    state = await json<State>(stateFile);
    if (
      state.schemaVersion !== 1 ||
      state.target !== options.target ||
      state.appName !== appName ||
      !/^[a-f0-9]{96}$/.test(state.clientId)
    )
      throw new SfciError(
        "Existing bootstrap state does not match this environment/app.",
        undefined,
        "AUTH_CONFIG",
      );
    if (state.orgId !== org.orgId && !options.afterRefresh)
      throw new SfciError(
        "The org ID changed since bootstrap.",
        "For a verified sandbox refresh, reconnect the administrator and pass --after-refresh. This does not reset its deployment baseline.",
        "ORG_CHANGED",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const existing = await sf.sf(
      [
        "data",
        "query",
        "--use-tooling-api",
        "--target-org",
        options.adminOrg,
        "--query",
        `SELECT Id FROM ExternalClientApplication WHERE DeveloperName = '${appName}'`,
      ],
      cwd,
    );
    if ((existing.records as unknown[] | undefined)?.length)
      throw new SfciError(
        "An app with this name already exists without matching local bootstrap state.",
        "Restore its private bootstrap directory or choose another --app-name. sfci will not overwrite an unrelated app.",
        "AUTH_CONFIG",
      );
    const existingSet = await sf.sf(
      [
        "data",
        "query",
        "--target-org",
        options.adminOrg,
        "--query",
        `SELECT Id FROM PermissionSet WHERE Name = '${appName}_Access' AND IsOwnedByProfile = false`,
      ],
      cwd,
    );
    if ((existingSet.records as unknown[] | undefined)?.length)
      throw new SfciError(
        "The app-access permission-set name is already in use.",
        "Choose another app name; bootstrap will not replace an existing permission set.",
        "AUTH_CONFIG",
      );
    state = {
      schemaVersion: 1,
      target: options.target,
      orgId: org.orgId,
      appName,
      clientId: randomBytes(48).toString("hex"),
    };
    createdState = true;
  }
  const keyFile = resolve(output, "server.key"),
    certificateFile = resolve(output, "server.crt");
  try {
    await lstat(keyFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!createdState)
      throw new SfciError(
        "The original private key is missing.",
        "Restore it from your secure store; bootstrap will not silently replace an active key.",
        "AUTH_CONFIG",
      );
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await writeFile(keyFile, privateKey, { flag: "wx", mode: 0o600 });
  }
  const keyInfo = await lstat(keyFile);
  if (!keyInfo.isFile() || keyInfo.mode & 0o077)
    throw new SfciError("JWT key must be a private regular file (0600).");
  if (createdState) await save(stateFile, state);
  let certificate: X509Certificate | null = null;
  try {
    const info = await lstat(certificateFile);
    if (!info.isFile())
      throw new SfciError("Certificate must be a regular file.");
    certificate = new X509Certificate(await readFile(certificateFile));
  } catch (error) {
    if (error instanceof SfciError)
      throw error; /* Create the public certificate below. */
  }
  if (
    !certificate ||
    Date.parse(certificate.validTo) < Date.now() + 30 * 86400000
  ) {
    const result = await execute(
      "openssl",
      [
        "req",
        "-new",
        "-x509",
        "-sha256",
        "-days",
        "365",
        "-key",
        keyFile,
        "-out",
        certificateFile,
        "-subj",
        `/CN=${appName}`,
      ],
      output,
    ).catch(() => {
      throw new SfciError(
        "OpenSSL is required to create the public certificate.",
        "Install OpenSSL or use the Nix runtime.",
        "AUTH_CONFIG",
      );
    });
    if (result.code)
      throw new SfciError(
        "OpenSSL could not create the certificate.",
        "Install OpenSSL or use the Nix runtime. Existing private files are preserved for retry.",
        "AUTH_CONFIG",
      );
    await chmod(certificateFile, 0o600);
    certificate = new X509Certificate(await readFile(certificateFile));
  }
  if (!certificate.checkPrivateKey(createPrivateKey(await readFile(keyFile))))
    throw new SfciError(
      "The saved certificate does not match the saved private key.",
      "Restore a matching pair from your secure store before updating the app.",
      "AUTH_CONFIG",
    );
  const project = resolve(output, "metadata");
  await mkdir(project, { recursive: true, mode: 0o700 });
  await save(resolve(project, "sfdx-project.json"), {
    packageDirectories: [{ path: "force-app", default: true }],
    sourceApiVersion: "68.0",
  });
  const source = resolve(project, "force-app", "main", "default");
  const accessSet = `${appName}_Access`;
  const definitions: [
    string,
    string,
    string,
    Record<string, string | boolean>,
  ][] = [
    [
      "externalClientApps",
      `${appName}.eca-meta.xml`,
      "ExternalClientApplication",
      {
        contactEmail: user.Email,
        description: `sfci JWT delivery for ${options.target}`,
        distributionState: "Local",
        isProtected: false,
        label: appName,
      },
    ],
    [
      "extlClntAppOauthSettings",
      `${appName}_OAuth.ecaOauth-meta.xml`,
      "ExtlClntAppOauthSettings",
      {
        commaSeparatedOauthScopes: "Api",
        externalClientApplication: appName,
        label: `${appName} OAuth`,
      },
    ],
    [
      "extlClntAppGlobalOauthSets",
      `${appName}_Global.ecaGlblOauth-meta.xml`,
      "ExtlClntAppGlobalOauthSettings",
      {
        callbackUrl: "https://login.salesforce.com/services/oauth2/success",
        certificate: certificate.toString(),
        consumerKey: state.clientId,
        externalClientApplication: appName,
        isConsumerSecretOptional: true,
        isCodeCredFlowEnabled: false,
        isClientCredentialsFlowEnabled: false,
        isNamedUserJwtEnabled: false,
        label: `${appName} Global`,
      },
    ],
    [
      "extlClntAppOauthPolicies",
      `${appName}_OAuthPolicy.ecaOauthPlcy-meta.xml`,
      "ExtlClntAppOauthConfigurablePolicies",
      {
        externalClientApplication: appName,
        commaSeparatedPermissionSet: accessSet,
        permittedUsersPolicyType: "AdminApprovedPreAuthorized",
        ipRelaxationPolicyType: "Enforce",
        isClientCredentialsFlowEnabled: false,
        label: `${appName} OAuth policy`,
      },
    ],
    [
      "extlClntAppPolicies",
      `${appName}_Policy.ecaPlcy-meta.xml`,
      "ExtlClntAppConfigurablePolicies",
      {
        externalClientApplication: appName,
        isEnabled: true,
        isOauthPluginEnabled: true,
        label: `${appName} Policy`,
      },
    ],
    [
      "permissionsets",
      `${accessSet}.permissionset-meta.xml`,
      "PermissionSet",
      {
        label: `${appName} app access`,
        description:
          "Authorizes this JWT app only. No API, metadata, profile or business permissions are granted.",
      },
    ],
  ];
  try {
    for (const [folder, file, type, fields] of definitions) {
      await mkdir(resolve(source, folder), { recursive: true, mode: 0o700 });
      await writeFile(resolve(source, folder, file), xml(type, fields), {
        mode: 0o600,
      });
    }
    await options.approve?.(
      `Configure ${appName} in ${org.orgId} (${env.type}) for ${options.username}? Certificate ${certificate.fingerprint256}. This grants app access only.`,
    );
    // Salesforce policies require permission-set IDs, so create the access-only set first.
    let permission = await sf.sf(
      [
        "data",
        "query",
        "--target-org",
        options.adminOrg,
        "--query",
        `SELECT Id FROM PermissionSet WHERE Name = '${accessSet}' AND IsOwnedByProfile = false`,
      ],
      cwd,
    );
    let createdSet = false;
    if (!(permission.records as unknown[] | undefined)?.length) {
      const prepared = await sf.sf(
        [
          "project",
          "deploy",
          "start",
          "--target-org",
          options.adminOrg,
          "--source-dir",
          resolve(source, "permissionsets"),
          "--wait",
          "30",
          "--ignore-conflicts",
        ],
        project,
      );
      if (prepared.success !== true || prepared.status !== "Succeeded")
        throw new SfciError(
          "App-access permission-set creation was not confirmed successful.",
        );
      createdSet = true;
      permission = await sf.sf(
        [
          "data",
          "query",
          "--target-org",
          options.adminOrg,
          "--query",
          `SELECT Id FROM PermissionSet WHERE Name = '${accessSet}' AND IsOwnedByProfile = false`,
        ],
        cwd,
      );
    }
    const permissionId = (
      permission.records as { Id?: string }[] | undefined
    )?.[0]?.Id;
    if (
      !permissionId ||
      !/^0PS[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(permissionId)
    )
      throw new SfciError("Cannot identify the app-access permission set.");
    // Do not overwrite permissions on an existing set during refresh/recovery.
    await rm(resolve(source, "permissionsets"), {
      recursive: true,
      force: true,
    });
    const policy = definitions.find(
      (definition) => definition[2] === "ExtlClntAppOauthConfigurablePolicies",
    )!;
    await writeFile(
      resolve(source, policy[0], policy[1]),
      xml(policy[2], {
        ...policy[3],
        commaSeparatedPermissionSet: permissionId,
      }),
      { mode: 0o600 },
    );
    const deployed = await sf.sf(
      [
        "project",
        "deploy",
        "start",
        "--target-org",
        options.adminOrg,
        "--source-dir",
        source,
        "--wait",
        "30",
        "--ignore-conflicts",
      ],
      project,
    );
    if (deployed.success !== true || deployed.status !== "Succeeded")
      throw new SfciError(
        "The bootstrap deployment is not confirmed successful.",
        "Inspect Salesforce Deployment Status before retrying. The private bootstrap state is preserved.",
        "PENDING",
      );
    const assignments = await sf.sf(
      [
        "data",
        "query",
        "--target-org",
        options.adminOrg,
        "--query",
        `SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${quote(String(user.Id))}' AND PermissionSet.Name = '${accessSet}'`,
      ],
      cwd,
    );
    if (!(assignments.records as unknown[] | undefined)?.length) {
      if (!createdSet)
        throw new SfciError(
          "The existing access set is not assigned to the integration user.",
          "Review its permissions, assign it explicitly with sf org assign permset, then rerun bootstrap.",
          "AUTH_CONFIG",
        );
      await sf.sf(
        [
          "org",
          "assign",
          "permset",
          "--target-org",
          options.adminOrg,
          "--name",
          accessSet,
          "--on-behalf-of",
          options.username,
        ],
        cwd,
      );
    }
    await authenticate(
      {
        ...options,
        cwd,
        clientId: state.clientId,
        username: options.username,
        instanceUrl: display.instanceUrl,
        jwtKeyFile: keyFile,
      },
      {},
    );
    const connected = await identify(options, env.org);
    if (connected.orgId !== org.orgId)
      throw new SfciError(
        "JWT authentication reached a different org.",
        undefined,
        "ORG_CHANGED",
      );
    const credentialsFile = resolve(output, "bitbucket-variables.json");
    await save(credentialsFile, {
      SF_CLIENT_ID: state.clientId,
      SF_USERNAME: options.username,
      SF_INSTANCE_URL: display.instanceUrl,
      SF_JWT_KEY_B64: (await readFile(keyFile)).toString("base64"),
    });
    await save(stateFile, { ...state, orgId: org.orgId });
    return {
      target: options.target,
      orgId: org.orgId,
      appName,
      clientId: state.clientId,
      certificateFingerprint: certificate.fingerprint256,
      credentialsFile,
      afterRefresh: options.afterRefresh ?? false,
    };
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}
