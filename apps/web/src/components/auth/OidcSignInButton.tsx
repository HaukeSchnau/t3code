import type { ServerAuthDescriptor } from "@t3tools/contracts";
import { T, Var } from "gt-react";

import { startOidcSignIn } from "../../oidcSignIn";
import { Button } from "../ui/button";

/** Signs this browser in to the server through its OpenID Connect provider. */
export function OidcSignInButton({
  signIn,
  disabled,
}: {
  signIn: NonNullable<ServerAuthDescriptor["oidc"]>;
  disabled: boolean;
}) {
  return (
    <Button
      disabled={disabled}
      // On another address of this server, the sign-in ends on the one it is registered for.
      onClick={() => startOidcSignIn(signIn.origin, signIn.origin)}
      size="standard"
    >
      <T>
        Sign in with <Var>{signIn.label}</Var>
      </T>
    </Button>
  );
}
