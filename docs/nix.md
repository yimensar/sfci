# Reproducible tools and image

The flake pins Nixpkgs through `flake.lock`. npm dependencies are pinned by
`package-lock.json` and checked by the fixed-output dependency hash in
`nix/package.nix`. The CLI, its private Salesforce CLI, Git Delta, Node and Git
are pinned together. No plugin installation runs when a CI job starts.

The dependency derivation reads only `package.json` and `package-lock.json`.
Its production output contains the runtime modules; a separate development
output supplies the compiler and tests during the application build. The small
application links to the production modules instead of copying them. Changing
only sfci source therefore preserves the dependency store path and allows the
image builder to reuse its large dependency layer. There is still one CLI to
install and one image to run.

## Develop

```sh
nix develop
npm ci
npm run dev -- --help
npm run check
```

The shell supplies Node and Git and adds local npm executables to `PATH`.
Dependencies are installed into the checkout only for development. Their exact
versions come from the lockfile. `nix build` uses an offline npm cache instead.

## Run or build

```sh
nix run . -- --help
nix build .#sfci
./result/bin/sfci --version
./result/bin/sf --version
nix flake check
```

Packages are declared for Apple Silicon macOS, ARM64 Linux and x86-64 Linux.
Each platform builds its own native package. The build checks types and runs the same isolated
tests as the npm workflow; the tests do not connect to Salesforce.

The first build downloads tools and dependency sources. Nix can reuse existing
store paths and binary substitutes on subsequent builds. Reproducibility does
not by itself guarantee a smaller image or faster Salesforce operations.

## Build the Linux CI image

On Linux, or with a configured Linux builder:

```sh
nix build .#image
docker load --input result
docker run --rm ghcr.io/yimensar/sfci:0.1.0-alpha.2 sfci --help
```

The image is built by `dockerTools.buildLayeredImage`; constructing it does not
require a Docker daemon. Docker is used above only to load and run the result.
The image includes runtime dependencies, CA certificates, Git/SSH and a shell
for CI platforms. It excludes Nix, TypeScript, the compiler and the build tools.
There is no forced entrypoint, so a provider can run its own checkout script.
The image also supplies the conventional Linux dynamic loader and C++ runtime
paths needed by GitHub's runner-injected Node binaries for JavaScript actions.
The publication workflow smoke-tests an injected host Node executable as well
as the image's own tools.

SGD 6.45.1's published npm shrinkwrap installs development tooling inside its own
package. The Nix build explicitly prunes that nested tree before the normal
production-only prune. Its runtime module and required dependencies remain;
the test suite runs before the installation is produced.
The packaged npm native-build helper scripts keep their upstream
`/usr/bin/env python3` shebangs. This prevents unused Python and compiler tools
from being retained in the runtime image by Nix's automatic shebang rewriting.
Installing or compiling extra native plugins inside the runtime image is outside
the supplied toolchain; dependencies are built before publication.

The default command is `sfci --help`. `/workspace` is the working directory.
For an interactive checkout, mount it and preserve the runner's user identity:

```sh
docker run --rm -it \
  --user 1000:1000 \
  --volume "$PWD:/workspace" \
  ghcr.io/yimensar/sfci:0.1.0-alpha.2 sfci status
```

CI services can run the image with their usual user and credentials mechanism.
Authentication files and deployment plans live outside the image and Nix store.
Use CI environment secrets for Salesforce credentials.

## Publish

The repository's CI builds and tests the npm installation and Nix package before
publishing the image with the repository's `GITHUB_TOKEN`:

- `main` publishes `ghcr.io/yimensar/sfci:edge`;
- a `v…` tag publishes the matching `package.json` version;
- each publication also gets a `sha-<commit>` tag identifying its source.

The initial publication workflow builds an x86-64 Linux image. The ARM64 Linux
image output is available in the flake for a native ARM64 builder; it is not
advertised as a published multi-platform image.

For the first GHCR publication, the package owner must open the GitHub package
settings and change **Package visibility → Public**. New packages default to
private even when their source repository is public. After that, verify an
anonymous pull before advertising the image as public.

An npm tarball is retained as a CI artifact. The workflow does not publish to npm;
that requires the package owner's npm publishing configuration.

## Update dependencies

After changing npm dependencies:

```sh
npm install
node scripts/normalize-lock.mjs
nix run --inputs-from . nixpkgs#prefetch-npm-deps -- package-lock.json
```

Put the printed `sha256-…` value into the dependency derivation’s `npmDepsHash`
in `nix/package.nix`, then run
`npm run check` and `nix flake check`. Review `flake.lock` updates independently
with `nix flake update`. Commit the lockfiles together with their intended source
changes. No dependency update should happen as a side effect of `sfci deploy`.

## Check dependency reuse

```sh
nix eval --raw .#sfci.dependencies.outPath
nix eval --raw .#sfci.outPath
```

Repeat after an sfci source-only change. The application path changes, while
`dependencies.outPath` stays the same. A lockfile, package metadata, Node or
packaging change can legitimately rebuild dependencies. On Linux, compare image
layer digests as well when changing image construction; store-path stability
alone is not a measurement of registry download time.
