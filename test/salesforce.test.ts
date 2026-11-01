import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentDiagnostics, waitForJob } from "../src/core/salesforce.js";
import { salesforceEnvironment } from "../src/core/process.js";
import { JobFailedError, type Runtime } from "../src/core/types.js";
import { reportError } from "../src/ui.js";
import { SF_VERSION } from "../src/toolchain.js";

const job = "0Af000000000001AAA";

async function failedJob(result: Record<string, unknown>): Promise<JobFailedError> {
  const runtime: Runtime = {
    async sf() {
      return result;
    },
  };
  try {
    await waitForJob({ cwd: process.cwd(), runtime }, "uat", job);
    assert.fail("The terminal deployment must fail");
  } catch (error) {
    assert.ok(error instanceof JobFailedError);
    assert.equal(error.result, result);
    return error;
  }
}

test("terminal Salesforce errors explain metadata failures and Apex test failures", async () => {
  const error = await failedJob({
    status: "Failed",
    success: false,
    done: true,
    rollbackOnError: true,
    details: {
      componentFailures: [
        {
          componentType: "ApexClass",
          fullName: "InvoiceService",
          fileName: "classes/InvoiceService.cls",
          lineNumber: 12,
          columnNumber: "9",
          problem: "Invalid type: MissingDependency",
        },
        {
          componentType: "CustomField",
          fullName: "Invoice__c.Customer__c",
          fileName: "objects/Invoice__c/fields/Customer__c.field-meta.xml",
          problem: "Reference to an unknown object",
        },
      ],
      runTestResult: {
        failures: [
          {
            name: "InvoiceServiceTest",
            methodName: "createsInvoice",
            message: "System.AssertException: Expected: 1, Actual: 0",
          },
        ],
      },
    },
  });
  assert.equal(error.code, "DEPLOYMENT_FAILED");
  assert.match(
    error.hint!,
    /ApexClass InvoiceService \(classes\/InvoiceService\.cls:12:9\): Invalid type: MissingDependency/,
  );
  assert.match(
    error.hint!,
    /CustomField Invoice__c\.Customer__c.*Reference to an unknown object/,
  );
  assert.match(
    error.hint!,
    /Apex InvoiceServiceTest\.createsInvoice: System\.AssertException/,
  );
  assert.match(error.hint!, /baseline was not advanced/);
});

test("SOAP singleton failures and coverage warnings retain useful names", async () => {
  const error = await failedJob({
    status: "Failed",
    done: true,
    details: {
      componentFailures: {
        componentType: "Flow",
        fullName: "InvoiceApproval",
        fileName: "flows/InvoiceApproval.flow-meta.xml",
        problem: "The referenced field does not exist",
      },
      runTestResult: {
        failures: {
          name: "InvoiceTest",
          methodName: "approves",
          message: "System.NullPointerException: Attempt to de-reference a null object",
        },
        codeCoverageWarnings: {
          name: "InvoiceService",
          message: "Code coverage is 60%. The required coverage is 75%.",
        },
      },
    },
  });
  assert.match(error.hint!, /Flow InvoiceApproval/);
  assert.match(error.hint!, /Apex InvoiceTest\.approves/);
  assert.match(error.hint!, /Coverage InvoiceService: Code coverage is 60%/);
  assert.match(error.hint!, /reconcile org state/);
});

test("diagnostics tolerate missing details and preserve Salesforce's general failure", () => {
  assert.equal(deploymentDiagnostics({ details: null }), "");
  assert.equal(
    deploymentDiagnostics({
      details: {
        componentFailures: [null, false, "unexpected", {}],
        runTestResult: [],
      },
    }),
    "",
  );
  assert.equal(
    deploymentDiagnostics({ errorMessage: "The deployment exceeds the maximum size" }),
    "The deployment exceeds the maximum size",
  );
});

test("diagnostics are bounded, deduplicated and redacted before truncation", () => {
  const prior = process.env.SFCI_TEST_TOKEN;
  const secret = "diagnostic-secret-that-crosses-the-field-limit";
  process.env.SFCI_TEST_TOKEN = secret;
  try {
    const diagnostic = deploymentDiagnostics({
      details: {
        componentFailures: Array.from({ length: 12 }, (_, index) => ({
          componentType: "ApexClass",
          fullName: `Example${index}`,
          problem: `${"x".repeat(280)}${secret}${"y".repeat(1000)}`,
        })),
      },
    });
    assert.equal(diagnostic.split("\n").length, 9);
    assert.match(diagnostic, /4 more error/);
    assert.ok(diagnostic.length < 3000);
    assert.doesNotMatch(diagnostic, /diagnostic-secret/);
    assert.equal(
      deploymentDiagnostics({
        details: {
          componentFailures: [
            { problem: "Same error\nwith control\u001bcharacters" },
            { problem: "Same error\nwith control\u001bcharacters" },
          ],
        },
      }).split("\n").length,
      1,
    );
  } finally {
    if (prior === undefined) delete process.env.SFCI_TEST_TOKEN;
    else process.env.SFCI_TEST_TOKEN = prior;
  }
});

test("JSON CLI error rendering keeps diagnostics and redacts authorization URLs", async () => {
  const authorization = "force://client:secret:refresh@example.invalid";
  const error = await failedJob({
    done: true,
    status: "Failed",
    details: { componentFailures: { problem: `Cannot use ${authorization}` } },
  });
  const write = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    reportError(error, { json: true, verbose: false });
  } finally {
    process.stdout.write = write;
  }
  const rendered = JSON.parse(output) as { error: { code: string; hint: string } };
  assert.equal(rendered.error.code, "DEPLOYMENT_FAILED");
  assert.match(rendered.error.hint, /REDACTED Salesforce authorization URL/);
  assert.doesNotMatch(output, /refresh@example|client:secret/);
});

test("a successful Salesforce result is returned unchanged", async () => {
  const result = { done: true, success: true, status: "Succeeded" };
  const runtime: Runtime = {
    async sf() {
      return result;
    },
  };
  assert.equal(
    await waitForJob({ cwd: process.cwd(), runtime }, "uat", job),
    result,
  );
  assert.ok(
    salesforceEnvironment().SF_DATA_DIR?.endsWith(`salesforce-${SF_VERSION}`),
  );
});
