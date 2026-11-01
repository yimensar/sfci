import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { VERSION } from "./version.js";

const require = createRequire(import.meta.url);
function installedVersion(name: string): string {
  let directory = dirname(require.resolve(name));
  for (;;) {
    try {
      const value = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8"),
      );
      if (value.name === name && typeof value.version === "string")
        return value.version;
    } catch {
      /* Entrypoints can be several directories below package.json. */
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new Error(`Cannot identify installed ${name}.`);
    directory = parent;
  }
}
export const SF_VERSION = installedVersion("@salesforce/cli");
export const TOOLCHAIN = `sfci/${VERSION};sgd/${installedVersion("sfdx-git-delta")};sf/${SF_VERSION};sdr/${installedVersion("@salesforce/source-deploy-retrieve")}`;
