{ lib, dockerTools, runtime, manifest, bashInteractive, coreutils, cacert, openssh, gnugrep, gnutar, gzip, glibc, stdenv }:

dockerTools.buildLayeredImage {
  name = "ghcr.io/yimensar/sfci";
  tag = manifest.version;
  maxLayers = 100;

  contents = [ runtime bashInteractive coreutils cacert openssh gnugrep gnutar gzip ];

  # CI platforms provide their own checkout and command, so there is no entrypoint.
  fakeRootCommands = ''
    mkdir -p ./tmp ./workspace ./home/sfci ./etc ./usr/bin ./lib ./lib64
    ln -s ${coreutils}/bin/env ./usr/bin/env
    # GitHub injects its own prebuilt Node binary for JavaScript actions.
    # That binary expects the conventional Linux ELF loader and library paths.
    ${if stdenv.hostPlatform.isAarch64 then ''
      ln -s ${stdenv.cc.bintools.dynamicLinker} ./lib/ld-linux-aarch64.so.1
    '' else ''
      ln -s ${stdenv.cc.bintools.dynamicLinker} ./lib64/ld-linux-x86-64.so.2
    ''}
    chmod 1777 ./tmp
    echo 'root:x:0:0:root:/root:/bin/bash' > ./etc/passwd
    echo 'sfci:x:1000:1000:sfci:/home/sfci:/bin/bash' >> ./etc/passwd
    echo 'root:x:0:' > ./etc/group
    echo 'sfci:x:1000:' >> ./etc/group
    chown -R 1000:1000 ./workspace ./home/sfci
  '';

  config = {
    Cmd = [ "sfci" "--help" ];
    WorkingDir = "/workspace";
    Env = [
      "PATH=/bin"
      "HOME=/home/sfci"
      "SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt"
      "GIT_SSL_CAINFO=${cacert}/etc/ssl/certs/ca-bundle.crt"
      "NODE_EXTRA_CA_CERTS=${cacert}/etc/ssl/certs/ca-bundle.crt"
      "LD_LIBRARY_PATH=${lib.makeLibraryPath [ glibc stdenv.cc.cc.lib ]}"
      "SF_AUTOUPDATE_DISABLE=true"
      "SF_DISABLE_TELEMETRY=true"
      "SF_USE_PROGRESS_BAR=false"
    ];
    Labels = {
      "org.opencontainers.image.title" = "sfci";
      "org.opencontainers.image.description" = manifest.description;
      "org.opencontainers.image.source" = "https://github.com/yimensar/sfci";
      "org.opencontainers.image.version" = manifest.version;
      "org.opencontainers.image.licenses" = "MIT";
    };
  };
}
