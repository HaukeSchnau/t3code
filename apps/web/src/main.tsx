import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

// First Clerk UI build containing https://github.com/clerk/javascript/pull/9500.
const electronClerkUI = {
  __internal_clerkUIVersion: "1.30.5-canary.v20260819050620",
};
const app = <AppRoot router={router} />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
   <React.StrictMode>
     {clerkPublishableKey && hasCloudPublicConfig() ? (
       isElectron ? (
         <ElectronClerkProvider
+          {...electronClerkUI}
           appearance={clerkAppearance}
           publishableKey={clerkPublishableKey}
           passkeys={passkeys}
         >
           <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
         </ElectronClerkProvider>
       ) : (
         <ClerkProvider appearance={clerkAppearance} publishableKey={clerkPublishableKey}>
           <ManagedRelayAuthProvider>{app}</ManagedRelayAuthProvider>
         </ClerkProvider>
       )
     ) : (
       app
   )}
   </React.StrictMode>,
);
