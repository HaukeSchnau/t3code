# Local web build scheduling

## Requirement

The production fleet deploys from `srv-2`, whose 12-core CPU builds the T3 web
bundle faster than the configured 6-core remote builder. Fleet configuration
must be able to keep that CPU-bound derivation on the deployment host without
disabling remote builders for the rest of the system closure.

## Implementation

`lib.mkT3CodePackageWith` accepts `preferLocalWebBuild`. The default package and
the compatibility `mkT3CodePackage` helper leave it disabled, so upstream and
other consumers retain normal Nix scheduling. The fleet opts in explicitly.

Production web builds also skip compressed-size reporting. Compression is only
used for the terminal size summary and does not affect emitted artifacts.

## Verification

Compare otherwise identical cold `nix build .#t3code.web --no-link -L` runs on
the fleet's configured remote builder and locally on the deployment host. Also
compare the output trees and evaluate the opted-in derivation to confirm that
`preferLocalBuild` is set.
