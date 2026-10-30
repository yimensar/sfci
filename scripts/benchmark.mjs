import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const binary = fileURLToPath(new URL("../bin/sfci.js", import.meta.url));
const results = {};
for (const command of ["--version", "--help"]) {
  const samples = [];
  for (let index = 0; index < 9; index++) {
    const started = performance.now();
    const child = spawnSync(process.execPath, [binary, command], {
      encoding: "utf8",
    });
    if (child.status !== 0)
      throw new Error(child.stderr || "CLI benchmark failed.");
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  results[command] = {
    minMs: Math.round(samples[0]),
    medianMs: Math.round(samples[4]),
    maxMs: Math.round(samples[8]),
    samples: samples.length,
  };
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      results,
    },
    null,
    2,
  ),
);
