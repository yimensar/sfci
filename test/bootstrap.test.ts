import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ComponentSet } from "@salesforce/source-deploy-retrieve";
import { bootstrap } from "../src/commands/bootstrap.js";
import type { Runtime } from "../src/core/types.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "sfci-bootstrap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "work"),
    output = join(directory, "credentials");
  await mkdir(cwd);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  await writeFile(
    join(cwd, "sfci.yml"),
    "trunk: main\nenvironments:\n  qa:\n    type: sandbox\n    org: delivery\n",
  );
  let orgId = "00D000000000001AAA",
    exists = false,
    setExists = false,
    assigned = false,
    authFails = false;
  const calls: string[][] = [],
    metadata: string[] = [];
  const runtime: Runtime = {
    async sf(args) {
      calls.push(args);
      const query = args[args.indexOf("--query") + 1] ?? "";
      if (args[0] === "data") {
        if (query.includes("FROM Organization"))
          return { records: [{ Id: orgId, IsSandbox: true }] };
        if (query.includes("FROM User"))
          return {
            records: [
              {
                Id: "005000000000001AAA",
                Email: "integration@example.invalid",
                IsActive: true,
              },
            ],
          };
        if (query.includes("FROM ExternalClientApplication"))
          return { records: exists ? [{ Id: "0xy000000000001AAA" }] : [] };
        if (query.includes("FROM PermissionSet WHERE"))
          return { records: setExists ? [{ Id: "0PS000000000001AAA" }] : [] };
        return { records: assigned ? [{ Id: "0Pa000000000001AAA" }] : [] };
      }
      if (args[0] === "org" && args[1] === "display")
        return {
          instanceUrl: "https://test.salesforce.com",
          accessToken: "DO_NOT_RETURN",
        };
      if (args[0] === "project") {
        const source = args[args.indexOf("--source-dir") + 1]!;
        if (!source.endsWith("permissionsets")) {
          const components = ComponentSet.fromSource(source);
          assert.equal(components.size, 5);
          for (const folder of await readdir(source))
            for (const file of await readdir(resolve(source, folder))) {
              const text = await readFile(
                resolve(source, folder, file),
                "utf8",
              );
              assert.doesNotMatch(text, /PRIVATE KEY|SF_JWT_KEY_B64/);
              metadata.push(text);
            }
          assert.match(metadata.at(-1) ?? "", /./);
          const policy = await readFile(
            resolve(
              source,
              "extlClntAppOauthPolicies",
              "Sfci_qa_OAuthPolicy.ecaOauthPlcy-meta.xml",
            ),
            "utf8",
          );
          assert.match(
            policy,
            /<commaSeparatedPermissionSet>0PS000000000001AAA<\/commaSeparatedPermissionSet>/,
          );
          assert.doesNotMatch(
            policy,
            /commaSeparatedProfile|>Relax|System Administrator/,
          );
          exists = true;
        } else setExists = true;
        return { status: "Succeeded", success: true };
      }
      if (args[0] === "org" && args[1] === "login") {
        assert.equal(args[2], "jwt");
        if (authFails) throw new Error("JWT rejected");
        return { accessToken: "DO_NOT_RETURN" };
      }
      if (args[0] === "org" && args[1] === "assign") assigned = true;
      return {};
    },
  };
  return {
    cwd,
    output,
    runtime,
    calls,
    metadata,
    options: {
      cwd,
      output,
      runtime,
      target: "qa",
      adminOrg: "admin",
      username: "ci@example.invalid",
    },
    refresh: () => {
      orgId = "00D000000000002AAA";
      exists = false;
      setExists = false;
      assigned = false;
    },
    foreignApp: () => {
      exists = true;
    },
    failAuth: () => {
      authFails = true;
    },
  };
}

test("bootstrap generates private credentials and only app-access permissions, deploys metadata, then verifies JWT", async (t) => {
  const f = await fixture(t);
  const result = await bootstrap(f.options);
  assert.equal(result.target, "qa");
  assert.match(result.clientId, /^[a-f0-9]{96}$/);
  const key = await readFile(join(f.output, "server.key"));
  const certificate = new X509Certificate(
    await readFile(join(f.output, "server.crt")),
  );
  assert.equal(certificate.checkPrivateKey(createPrivateKey(key)), true);
  assert.equal((await stat(f.output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.output, "server.key"))).mode & 0o777, 0o600);
  assert.equal((await stat(result.credentialsFile)).mode & 0o777, 0o600);
  const variables = JSON.parse(await readFile(result.credentialsFile, "utf8"));
  assert.equal(variables.SF_JWT_KEY_B64, key.toString("base64"));
  assert.doesNotMatch(
    JSON.stringify(result),
    /DO_NOT_RETURN|PRIVATE KEY|SF_JWT_KEY_B64/,
  );
  await assert.rejects(stat(join(f.output, "metadata")), { code: "ENOENT" });
  const before = result.clientId;
  const repeated = await bootstrap(f.options);
  assert.equal(repeated.clientId, before);
  assert.equal(
    (await readFile(join(f.output, "server.key"))).toString(),
    key.toString(),
  );
});

test("sandbox refresh requires explicit acceptance, reuses its own key, and never resets a baseline", async (t) => {
  const f = await fixture(t);
  const first = await bootstrap(f.options);
  f.refresh();
  await assert.rejects(bootstrap(f.options), /org ID changed/);
  const restored = await bootstrap({ ...f.options, afterRefresh: true });
  assert.notEqual(restored.orgId, first.orgId);
  assert.equal(restored.clientId, first.clientId);
  assert.equal(restored.certificateFingerprint, first.certificateFingerprint);
  assert.equal(
    f.calls.some((args) => args.includes("baseline")),
    false,
  );
});

test("bootstrap does not overwrite a foreign app or store credentials in a repository", async (t) => {
  const f = await fixture(t);
  f.foreignApp();
  await assert.rejects(bootstrap(f.options), /already exists/);
  await assert.rejects(
    bootstrap({ ...f.options, output: join(f.cwd, ".sfci", "keys") }),
    /Git repository/,
  );
  assert.equal(
    f.calls.some((args) => args[0] === "project"),
    false,
  );
});

test("a failed JWT verification preserves recoverable key state but emits no CI credentials", async (t) => {
  const f = await fixture(t);
  f.failAuth();
  await assert.rejects(bootstrap(f.options), /JWT rejected/);
  assert.ok(await stat(join(f.output, "server.key")));
  await assert.rejects(stat(join(f.output, "bitbucket-variables.json")), {
    code: "ENOENT",
  });
  await assert.rejects(stat(join(f.output, "metadata")), { code: "ENOENT" });
});

test("a mismatched certificate/key or missing original key stops before any org mutation", async (t) => {
  const f = await fixture(t);
  await bootstrap(f.options);
  f.calls.length = 0;
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const key = join(f.output, "server.key");
  await writeFile(key, privateKey);
  await assert.rejects(bootstrap(f.options), /does not match/);
  await rm(key);
  await assert.rejects(bootstrap(f.options), /original private key is missing/);
  assert.equal(f.calls.some((args) => args[0] === "project" || args[1] === "assign"), false);
});

test("declared org type and refresh restrictions are checked before writes", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "sfci.yml"), "trunk: main\nenvironments:\n  qa:\n    type: production\n    org: delivery\n");
  await assert.rejects(bootstrap(f.options), /org type does not match/);
  await assert.rejects(bootstrap({ ...f.options, afterRefresh: true }), /only available for sandbox/);
  assert.equal(f.calls.some((args) => args[0] === "project"), false);
  await assert.rejects(stat(f.output), { code: "ENOENT" });
});
