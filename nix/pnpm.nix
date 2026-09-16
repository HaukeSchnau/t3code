pkgs: nodejs:
(pkgs.pnpm_11.override { inherit nodejs; }).overrideAttrs {
  version = "11.10.0";
  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/pnpm/-/pnpm-11.10.0.tgz";
    hash = "sha256-YgtmBepPYvxWptCphzP0eQcdAyHgPkhrUix+mnRhdDE=";
  };
}
