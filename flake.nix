{
  description = "sfci — reproducible Salesforce delivery tools and CI image";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      packageFor = system:
        let
          pkgs = import nixpkgs { inherit system; };
          manifest = builtins.fromJSON (builtins.readFile ./package.json);
          sfci = pkgs.callPackage ./nix/package.nix { };
          runtime = pkgs.symlinkJoin {
            name = "sfci-runtime-${manifest.version}";
            paths = [ sfci pkgs.nodejs_22 pkgs.gitMinimal ];
          };
        in {
          inherit pkgs sfci runtime manifest;
        };
    in {
      packages = forAllSystems (system:
        let p = packageFor system;
        in {
          inherit (p) sfci runtime;
          default = p.sfci;
        } // nixpkgs.lib.optionalAttrs p.pkgs.stdenv.hostPlatform.isLinux {
          image = p.pkgs.callPackage ./nix/image.nix {
            inherit (p) runtime manifest;
          };
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.sfci}/bin/sfci";
          meta.description = "Run the pinned sfci Salesforce delivery CLI";
        };
      });

      devShells = forAllSystems (system:
        let p = packageFor system;
        in {
          default = p.pkgs.mkShell {
            packages = [ p.pkgs.nodejs_22 p.pkgs.gitMinimal p.pkgs.openssl ];
            shellHook = ''
              export PATH="$PWD/node_modules/.bin:$PATH"
            '';
          };
        });

      checks = forAllSystems (system: {
        package = self.packages.${system}.sfci;
      });
    };
}
