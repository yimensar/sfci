import { build } from "esbuild";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
await rm(new URL("../dist/", import.meta.url), {
  recursive: true,
  force: true,
});
await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts"],
  outdir: "dist",
  bundle: true,
  splitting: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: false,
  define: { __SFCI_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "info",
});
