{ lib, buildNpmPackage, nodejs_22, gitMinimal, makeWrapper }:

let
  manifest = builtins.fromJSON (builtins.readFile ../package.json);
in buildNpmPackage {
  pname = "sfci";
  version = manifest.version;
  nodejs = nodejs_22;

  src = lib.cleanSourceWith {
    src = ../.;
    filter = path: type:
      let name = baseNameOf path;
      in !(builtins.elem name [ "node_modules" "dist" ".sfci" ".git" "result" ])
        && !(lib.hasPrefix "result-" name)
        && lib.cleanSourceFilter path type;
  };

  # Updated only when package-lock.json changes. See docs/nix.md.
  npmDepsHash = "sha256-MddkSse6mkdlLjSqcsg52g+H1ijK+2K4dUB6jl6d8vg=";
  npmPackFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [ gitMinimal makeWrapper ];

  preBuild = ''
    npm run typecheck
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  # SGD 6.45.1's published shrinkwrap brings its development tools along.
  # Prune that nested package before the normal root production-only prune.
  preInstall = ''
    npm prune --prefix node_modules/sfdx-git-delta \
      --omit=dev --ignore-scripts --offline --no-audit --no-fund
  '';

  postInstall = ''
    wrapProgram "$out/bin/sfci" \
      --prefix PATH : ${lib.makeBinPath [ gitMinimal ]}

    makeWrapper ${nodejs_22}/bin/node "$out/bin/sf" \
      --add-flags "$out/lib/node_modules/${manifest.name}/node_modules/@salesforce/cli/bin/run.js" \
      --set SF_AUTOUPDATE_DISABLE true \
      --set SF_DISABLE_TELEMETRY true \
      --run 'export SF_DATA_DIR="$HOME/.cache/sfci/salesforce-${manifest.dependencies."@salesforce/cli"}"' \
      --prefix PATH : ${lib.makeBinPath [ gitMinimal ]}
  '';

  meta = {
    description = manifest.description;
    homepage = "https://github.com/yimensar/sfci";
    license = lib.licenses.mit;
    mainProgram = "sfci";
    platforms = lib.platforms.unix;
  };
}
