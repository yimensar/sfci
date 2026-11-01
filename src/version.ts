import pkg from "../package.json" with { type: "json" };
declare const __SFCI_VERSION__: string | undefined;
export const VERSION =
  typeof __SFCI_VERSION__ === "string" ? __SFCI_VERSION__ : pkg.version;
