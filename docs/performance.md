# Performance measurements

These are initial local measurements, not a comparison with another CI tool.

On 30 October 2026, Apple Silicon macOS:

| Measurement | Result | Conditions |
| --- | --- | --- |
| `sfci --version` | 27 ms median | Built JavaScript, Node 24.15.0, 9 fresh processes |
| `sfci --help` | 28 ms median | Built JavaScript, Node 24.15.0, 9 fresh processes |
| Installed Nix `sfci --version` | 37 ms median | Pinned Node 22.23.4, 10 fresh processes |
| Nix runtime closure | 523,136,696 bytes | macOS package and all referenced runtime paths |

The closure size is **not** the Linux image's compressed download size. The
publication workflow measures and smoke-tests the Linux image separately.

The optimized closure excludes accidental references to Python, Clang and the
macOS SDK from optional npm native-build helper scripts. The earlier closure
was 1,886,111,848 bytes. This is packaging cleanup, not faster Salesforce tests.

Run `npm run build && node scripts/benchmark.mjs` to repeat the CLI startup
measurement. Salesforce validation time, image pull time, repository size and
Git Delta planning time need separate measurements in a real project.

The Nix package now keeps production dependencies in a separate derivation
whose inputs are the package metadata and lockfile. The application contains
its own JavaScript and a link to those modules. This allows source-only changes
to reuse the dependency store path and image layer. The size measurements above
predate this split; they are not new image or transfer benchmarks. See
[the reuse check](nix.md#check-dependency-reuse) to verify the package boundary.
