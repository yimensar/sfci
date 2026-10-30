declare const __SFCI_VERSION__: string | undefined;
export const VERSION =
  typeof __SFCI_VERSION__ === "string" ? __SFCI_VERSION__ : "0.1.0-alpha.1";
