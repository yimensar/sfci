{ lib, stdenv, buildNpmPackage, nodejs_22, gitMinimal, openssl, makeWrapper }:

let
  manifest = builtins.fromJSON (builtins.readFile ../package.json);

  # Only the lockfile and package metadata affect this large output. An sfci
  # source change rebuilds the small application, keeping dependency layers.
  dependencies = buildNpmPackage {
    pname = "sfci-dependencies";
    version = "1";
    nodejs = nodejs_22;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [ ../package.json ../package-lock.json ];
    };
    npmDepsHash = "sha256-p6fTL3uNJplTp4td29gqCmnbskQznipgJIEKbDE/t08=";
    outputs = [ "out" "development" ];
    dontNpmBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$development" "$out"
      cp -r node_modules "$development/node_modules"

      # SGD's published shrinkwrap also installs its development tools.
      npm prune --prefix node_modules/sfdx-git-delta \
        --omit=dev --ignore-scripts --offline --no-audit --no-fund
      npm prune --omit=dev --ignore-scripts --offline --no-audit --no-fund
      cp -r node_modules "$out/node_modules"
      runHook postInstall
    '';
    postFixup = ''
      # These optional native-build helpers are not part of sfci execution.
      # Avoid retaining build Python and its compiler through patched shebangs.
      node_gyp="$out/node_modules/npm/node_modules/node-gyp"
      if [ -d "$node_gyp" ]; then
        while IFS= read -r -d $'\0' helper; do
          substituteInPlace "$helper" \
            --replace-quiet '${nodejs_22.python}/bin/python3' '/usr/bin/env python3'
        done < <(find "$node_gyp" -type f -name '*.py' -print0)
      fi
    '';
  };
in stdenv.mkDerivation {
  pname = "sfci";
  version = manifest.version;

  src = lib.cleanSourceWith {
    src = ../.;
    filter = path: type:
      let name = baseNameOf path;
      in !(builtins.elem name [ "node_modules" "dist" ".sfci" ".git" "result" ])
        && !(lib.hasPrefix "result-" name)
        && lib.cleanSourceFilter path type;
  };

  nativeBuildInputs = [ nodejs_22 gitMinimal makeWrapper openssl ];
  dontStrip = true;
  buildPhase = ''
    runHook preBuild
    export HOME="$TMPDIR/sfci-home"
    mkdir -p "$HOME"
    ln -s ${dependencies.development}/node_modules node_modules
    npm run typecheck
    npm run build
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    package_out="$out/lib/node_modules/${manifest.name}"
    mkdir -p "$package_out" "$out/bin"
    cp -r bin dist package.json LICENSE THIRD_PARTY_NOTICES.md README.md "$package_out/"
    ln -s ${dependencies}/node_modules "$package_out/node_modules"

    makeWrapper ${nodejs_22}/bin/node "$out/bin/sfci" \
      --add-flags "$package_out/bin/sfci.js" \
      --prefix PATH : ${lib.makeBinPath [ gitMinimal openssl ]}
    makeWrapper ${nodejs_22}/bin/node "$out/bin/sf" \
      --add-flags "${dependencies}/node_modules/@salesforce/cli/bin/run.js" \
      --set SF_AUTOUPDATE_DISABLE true \
      --set SF_DISABLE_TELEMETRY true \
      --run 'export SF_DATA_DIR="$HOME/.cache/sfci/salesforce-${manifest.dependencies."@salesforce/cli"}"' \
      --prefix PATH : ${lib.makeBinPath [ gitMinimal openssl ]}
    runHook postInstall
  '';

  passthru = { inherit dependencies; };
  meta = {
    description = manifest.description;
    homepage = "https://github.com/yimensar/sfci";
    license = lib.licenses.mit;
    mainProgram = "sfci";
    platforms = lib.platforms.unix;
  };
}
