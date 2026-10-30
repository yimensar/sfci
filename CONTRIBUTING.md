# Contributing

Use `nix develop` for the pinned development environment, then `npm ci`.

Before submitting a change, run `npm run check` and `nix flake check`. Add a regression test when changing deployment behavior. Tests must use temporary repositories and simulated Salesforce responses, never a live org or credentials from the developer's machine.

Keep the public commands small and errors actionable. Prefer a direct function over an abstraction that has only one use. Preserve JSON output as a versioned interface. Keep terminal presentation outside the delivery core.

Dependencies must be pinned and reviewed. Updating `package-lock.json` also requires updating the Nix dependency hash as described in `docs/nix.md`.

Do not include generated plans, org metadata, authentication state, or business data in a pull request.
