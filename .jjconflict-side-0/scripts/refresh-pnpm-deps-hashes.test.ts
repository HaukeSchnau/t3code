// @effect-diagnostics nodeBuiltinImport:off - tests the standalone repository CLI.
import { assert, describe, it } from "@effect/vitest";

import { parseExpectedHashes, updatePnpmDepsHashes } from "./refresh-pnpm-deps-hashes.ts";

describe("pnpm dependency hash refresh", () => {
  it("extracts all dependency hashes from Nix output", () => {
    assert.deepStrictEqual(
      parseExpectedHashes(`
error: build on a remote failed: hash mismatch in fixed-output derivation '/nix/store/a-t3code-server-deps-1.pnpm-deps.drv':
         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
              got:    sha256-SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS=
error: hash mismatch in fixed-output derivation '/nix/store/b-t3code-web-deps-1.pnpm-deps.drv':
         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
              got:    sha256-WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW=
error: hash mismatch in fixed-output derivation '/nix/store/c-t3code-runtime-deps-1.pnpm-deps.drv':
         specified: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
              got:    sha256-RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR=
      `),
      {
        web: "sha256-WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW=",
        server: "sha256-SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS=",
        runtime: "sha256-RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR=",
      },
    );
  });

  it("updates only the three configured dependency hashes", () => {
    const source = `
      pnpmDepsHashes ? {
        web = "old-web";
        server = "old-server";
        runtime = "old-runtime";
      },
      unrelated = "keep-me";
    `;
    assert.strictEqual(
      updatePnpmDepsHashes(source, {
        web: "sha256-web=",
        server: "sha256-server=",
        runtime: "sha256-runtime=",
      }),
      `
      pnpmDepsHashes ? {
        web = "sha256-web=";
        server = "sha256-server=";
        runtime = "sha256-runtime=";
      },
      unrelated = "keep-me";
    `,
    );
  });

  it("rejects a flake that omits one dependency hash", () => {
    assert.throws(
      () =>
        updatePnpmDepsHashes(
          `pnpmDepsHashes ? {
            web = "old-web";
            server = "old-server";
          },`,
          {
            web: "sha256-web=",
            server: "sha256-server=",
            runtime: "sha256-runtime=",
          },
        ),
      /runtime pnpm dependency hash/,
    );
  });
});
