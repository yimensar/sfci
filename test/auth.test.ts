import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { authenticate } from "../src/commands/auth.js";
import { SfciError, type Runtime } from "../src/core/types.js";
import { CliError } from "../src/ui.js";

const pem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const credentials = {
  SF_CLIENT_ID: "fixture-client",
  SF_USERNAME: "ci@example.invalid",
  SF_INSTANCE_URL: "https://test.salesforce.com",
  SF_JWT_KEY_B64: Buffer.from(pem).toString("base64"),
};

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), "sfci-auth-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(
    join(cwd, "sfci.yml"),
    "trunk: main\nenvironments:\n  uat:\n    org: partial\n  production:\n    org: production\n",
  );
  return cwd;
}

test("JWT auth delegates to Salesforce, restricts and removes its temporary key, and returns no token", async (t) => {
  const cwd = await fixture(t);
  let keyPath = "";
  const runtime: Runtime = {
    async sf(args, workingDirectory) {
      assert.equal(workingDirectory, cwd);
      assert.deepEqual(args.slice(0, 3), ["org", "login", "jwt"]);
      assert.ok(args.includes("--alias=partial"));
      assert.ok(args.includes("--client-id=fixture-client"));
      assert.ok(args.includes("--username=ci@example.invalid"));
      assert.ok(args.includes("--instance-url=https://test.salesforce.com"));
      keyPath = args
        .find((value) => value.startsWith("--jwt-key-file="))!
        .slice("--jwt-key-file=".length);
      assert.equal(await readFile(keyPath, "utf8"), pem);
      assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(keyPath))).mode & 0o777, 0o700);
      assert.ok(!keyPath.startsWith(`${cwd}/`));
      return {
        accessToken: "MUST_NOT_LEAVE_SALESFORCE",
        refreshToken: "NEVER_RETURN",
      };
    },
  };
  const result = await authenticate(
    { cwd, target: "uat", runtime },
    credentials,
  );
  assert.deepEqual(result, { target: "uat", org: "partial", method: "jwt" });
  await assert.rejects(stat(dirname(keyPath)), { code: "ENOENT" });
});

test("JWT private key is removed when Salesforce rejects authentication", async (t) => {
  const cwd = await fixture(t);
  let keyPath = "";
  const runtime: Runtime = {
    async sf(args) {
      keyPath = args
        .find((value) => value.startsWith("--jwt-key-file="))!
        .slice("--jwt-key-file=".length);
      throw new SfciError(
        "invalid_grant: user is not approved",
        "Inspect Deployment Status",
        "SALESFORCE",
      );
    },
  };
  await assert.rejects(
    authenticate({ cwd, target: "uat", runtime }, credentials),
    (error) =>
      error instanceof CliError &&
      error.code === "AUTH_FAILED" &&
      error.message.includes("invalid_grant") &&
      error.hint?.includes("JWT") === true &&
      !error.hint.includes("Deployment Status"),
  );
  await assert.rejects(stat(dirname(keyPath)), { code: "ENOENT" });
});

test("explicit JWT options use a caller-owned key file without deleting it", async (t) => {
  const cwd = await fixture(t);
  const path = join(cwd, "caller.key");
  await writeFile(path, pem, { mode: 0o600 });
  const runtime: Runtime = {
    async sf(args) {
      assert.ok(args.includes(`--jwt-key-file=${path}`));
      assert.ok(args.includes("--client-id=explicit-client"));
      assert.ok(args.includes("--alias=production"));
      return {};
    },
  };
  await authenticate(
    {
      cwd,
      target: "production",
      runtime,
      clientId: "explicit-client",
      jwtKeyFile: "caller.key",
    },
    credentials,
  );
  assert.equal(await readFile(path, "utf8"), pem);
});

test("missing credentials and malformed/non-RSA keys fail before invoking Salesforce", async (t) => {
  const cwd = await fixture(t);
  const runtime: Runtime = {
    async sf() {
      assert.fail("Must fail before invoking Salesforce");
    },
  };
  const bad = [
    { ...credentials, SF_CLIENT_ID: "" },
    { ...credentials, SF_USERNAME: "" },
    { ...credentials, SF_INSTANCE_URL: "http://example.invalid" },
    { ...credentials, SF_JWT_KEY_B64: "" },
    { ...credentials, SF_JWT_KEY_B64: "not base64!" },
    {
      ...credentials,
      SF_JWT_KEY_B64: Buffer.from("not a private key").toString("base64"),
    },
    {
      ...credentials,
      SF_JWT_KEY_B64: Buffer.from(
        generateKeyPairSync("ec", {
          namedCurve: "prime256v1",
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey,
      ).toString("base64"),
    },
    { ...credentials, SF_JWT_KEY_FILE: join(cwd, "missing.key") },
  ];
  for (const environment of bad)
    await assert.rejects(
      authenticate({ cwd, target: "uat", runtime }, environment),
      /JWT|instance URL/,
    );
});

test("existing SFDX_CLIENT_ID variables remain usable for Bitbucket migrations", async (t) => {
  const cwd = await fixture(t);
  const { SF_CLIENT_ID: id, ...rest } = credentials;
  const runtime: Runtime = {
    async sf(args) {
      assert.ok(args.includes(`--client-id=${id}`));
      return {};
    },
  };
  await authenticate(
    { cwd, target: "uat", runtime },
    { ...rest, SFDX_CLIENT_ID: id },
  );
});
