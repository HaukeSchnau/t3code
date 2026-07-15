import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "../components/auth/PairingRouteSurface";
import { hasHostedPairingRequest } from "../hostedPairing";

export const Route = createFileRoute("/pair")({
  beforeLoad: async ({ context, location }) => {
    const { authGateState } = context;
    const currentUrl = new URL(location.href, window.location.origin);
    const browserUrl = new URL(window.location.href);
    if (
      authGateState.status === "hosted-pairing" ||
      hasHostedPairingRequest(currentUrl) ||
      hasHostedPairingRequest(browserUrl)
    ) {
      return {
        authGateState: {
          status: "hosted-pairing",
        } as const,
      };
    }

    if (
      authGateState.status === "authenticated" ||
      authGateState.status === "offline-authenticated" ||
      authGateState.status === "hosted-static"
    ) {
      throw redirect({ to: "/", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface />;
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        void navigate({ to: "/", replace: true });
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
