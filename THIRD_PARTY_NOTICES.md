# Third-party software

sfci's original source is licensed under MIT. Its distributions also contain
third-party packages governed by their respective licenses. Their copyright and
license files remain in the installed packages.

The principal runtime dependencies are:

| Package | License |
| --- | --- |
| `@salesforce/cli` | Apache-2.0 |
| `sfdx-git-delta` | MIT |
| `commander` | MIT |
| `@clack/prompts` | MIT |
| `fflate` | MIT |
| `yaml` | ISC |

The Nix image additionally includes Node.js, Git, OpenSSH and small system tools.
Their license and copyright notices are supplied by their respective packages.
The root `LICENSE` covers sfci only and does not relicense these dependencies.

sfci is an independent project and is not an official Salesforce product.
