/**
 * `/prototypes/sidebar-organization` — standalone, server-free prototype of
 * the orchestration sidebar. Desktop shows the sidebar beside a stand-in
 * thread pane; the phone layout swaps between list and detail screens, and
 * sits in a frame when forced on a wide screen.
 */
import { ChevronLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { PrototypeControls } from "./PrototypeControls";
import { PrototypeDetail } from "./PrototypeDetail";
import { PrototypeSidebar } from "./PrototypeSidebar";
import { usePrototypeStore } from "./store";
import { useSidebarModel } from "./useSidebarModel";

function useThemeClass() {
  const theme = usePrototypeStore((s) => s.theme);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
}

function PhoneScreens({ model }: { readonly model: ReturnType<typeof useSidebarModel> }) {
  const selectedId = usePrototypeStore((s) => s.selectedId);
  const [screen, setScreen] = useState<"list" | "detail">("list");
  // A selection made from the list opens the detail screen, as a tap would.
  const [lastSelection, setLastSelection] = useState(selectedId);
  if (selectedId !== lastSelection) {
    setLastSelection(selectedId);
    if (selectedId !== null) setScreen("detail");
  }
  if (screen === "detail" && selectedId !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="flex h-11 shrink-0 items-center border-b border-border/60 px-1">
          <Button size="sm" variant="ghost" onClick={() => setScreen("list")}>
            <ChevronLeftIcon aria-hidden />
            Threads
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PrototypeDetail model={model} />
        </div>
      </div>
    );
  }
  return <PrototypeSidebar model={model} className="h-full" />;
}

export function SidebarOrganizationPrototypePage() {
  useThemeClass();
  const model = useSidebarModel();

  if (model.device === "phone") {
    const screens = <PhoneScreens model={model} />;
    return (
      <div className="h-dvh bg-background text-foreground">
        {model.framed ? (
          <div className="flex h-full items-center justify-center bg-muted/40 p-6">
            <div className="h-[780px] max-h-full w-[390px] overflow-hidden rounded-[2rem] border-[6px] border-neutral-800 bg-background shadow-2xl dark:border-neutral-700">
              {screens}
            </div>
          </div>
        ) : (
          screens
        )}
        <PrototypeControls />
      </div>
    );
  }

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <aside aria-label="Threads" className="w-64 shrink-0 border-e border-sidebar-border/70">
        <PrototypeSidebar model={model} />
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <PrototypeDetail model={model} />
      </main>
      <PrototypeControls />
    </div>
  );
}
