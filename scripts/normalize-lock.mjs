import { readFile, writeFile } from "node:fs/promises";

// SGD's published shrinkwrap contributes dead development records. They can
// make a clean Nix install try to install binaries for another CPU or OS.
const path = new URL("../package-lock.json", import.meta.url);
const lock = JSON.parse(await readFile(path, "utf8"));
let removed = 0;
for (const [name, entry] of Object.entries(lock.packages)) {
  if (entry.extraneous === true) {
    delete lock.packages[name];
    removed++;
  }
}
await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Removed ${removed} extraneous lock records.`);
