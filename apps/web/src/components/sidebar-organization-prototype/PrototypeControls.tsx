/**
 * Discreet reviewer panel: scenario, simulated device, theme, a few state
 * events that exercise the rules without expanding anything, and reset.
 */
import { SlidersHorizontalIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { ProtoThread } from "./data";
import { usePrototypeStore, type DeviceChoice, type ThemeChoice } from "./store";

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

const DEVICES: ReadonlyArray<{ value: DeviceChoice; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "desktop", label: "Desktop" },
  { value: "phone", label: "Phone" },
];
const THEMES: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function isDevice(value: string): value is DeviceChoice {
  return DEVICES.some((d) => d.value === value);
}
function isTheme(value: string): value is ThemeChoice {
  return THEMES.some((t) => t.value === value);
}

function Events() {
  const threads = usePrototypeStore((s) => s.threads);
  const efforts = usePrototypeStore((s) => s.efforts);
  const updateThread = usePrototypeStore((s) => s.updateThread);
  const updateEffort = usePrototypeStore((s) => s.updateEffort);
  const addThread = usePrototypeStore((s) => s.addThread);
  const select = usePrototypeStore((s) => s.select);
  const byId = new Map(threads.map((t) => [t.id, t]));

  const sol = byId.get("sol-rules");
  const claude = byId.get("ad-claude");
  const claudeRetry = byId.get("ad-claude-2");
  const rules = efforts.find((e) => e.id === "e-rules");
  const genova = byId.get("casa-genova");
  const doneUnsettled = threads.filter(
    (t) => t.parentId !== null && t.state === "completed" && !t.settled,
  );

  const actions: ReadonlyArray<{
    key: string;
    label: string;
    hint: string;
    run: () => void;
    disabled?: boolean;
  }> = [
    ...(sol
      ? [
          {
            key: "flip",
            label:
              sol.state === "blocked" ? "Unblock Sol · sidebar rules" : "Block Sol · sidebar rules",
            hint: "Count changes; nothing expands.",
            run: () =>
              updateThread(sol.id, { state: sol.state === "blocked" ? "working" : "blocked" }),
          },
        ]
      : []),
    ...(genova
      ? [
          {
            key: "genova",
            label:
              genova.state === "blocked" ? "Unblock Casa Crema Genova" : "Block Casa Crema Genova",
            hint: "Bare-children tray.",
            run: () =>
              updateThread(genova.id, {
                state: genova.state === "blocked" ? "working" : "blocked",
              }),
          },
        ]
      : []),
    ...(rules
      ? [
          {
            key: "close",
            label: rules.closed ? "Reopen Sidebar rules debate" : "Close Sidebar rules debate",
            hint: "Members stay; the effort stays current until they settle.",
            run: () => updateEffort(rules.id, { closed: !rules.closed }),
          },
        ]
      : []),
    ...(claude
      ? [
          {
            key: "retry",
            label: "Retry Claude adapter",
            hint: "Failure is superseded; the retry takes its row.",
            disabled: claudeRetry !== undefined,
            run: () => {
              const retry: ProtoThread = {
                ...claude,
                id: "ad-claude-2",
                title: "Claude adapter · retry",
                state: "working",
                unread: false,
                replacesId: claude.id,
                age: "now",
              };
              addThread(retry, claude.id);
              select(`thread:${retry.id}`);
            },
          },
        ]
      : []),
    {
      key: "settle-done",
      label: `Settle done workers (${doneUnsettled.length})`,
      hint: "Done rows move to Settled; efforts with nothing current become past.",
      disabled: doneUnsettled.length === 0,
      run: () => {
        for (const t of doneUnsettled) updateThread(t.id, { settled: true, unread: false });
      },
    },
  ];

  return (
    <ul className="flex flex-col gap-1">
      {actions.map((action) => (
        <li key={action.key}>
          <button
            type="button"
            disabled={action.disabled}
            onClick={action.run}
            className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="text-xs font-medium">{action.label}</span>
            <span className="text-[11px] text-muted-foreground">{action.hint}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function PrototypeControls({ className }: { readonly className?: string }) {
  const [open, setOpen] = useState(false);
  const device = usePrototypeStore((s) => s.device);
  const theme = usePrototypeStore((s) => s.theme);
  const setDevice = usePrototypeStore((s) => s.setDevice);
  const setTheme = usePrototypeStore((s) => s.setTheme);
  const reset = usePrototypeStore((s) => s.reset);

  return (
    <div
      className={cn(
        "pointer-events-none fixed bottom-3 right-3 z-30 flex flex-col items-end gap-2",
        className,
      )}
    >
      {open ? (
        <div className="pointer-events-auto flex w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-3 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Prototype</span>
            <Button
              aria-label="Close"
              size="icon-xs"
              variant="ghost-muted"
              onClick={() => setOpen(false)}
            >
              <XIcon aria-hidden />
            </Button>
          </div>
          <Field label="Device">
            <ToggleGroup
              aria-label="Device"
              variant="segmented"
              value={[device]}
              onValueChange={(next) => {
                const value = next[0];
                if (typeof value === "string" && isDevice(value)) setDevice(value);
              }}
            >
              {DEVICES.map((d) => (
                <Toggle key={d.value} value={d.value}>
                  {d.label}
                </Toggle>
              ))}
            </ToggleGroup>
          </Field>
          <Field label="Theme">
            <ToggleGroup
              aria-label="Theme"
              variant="segmented"
              value={[theme]}
              onValueChange={(next) => {
                const value = next[0];
                if (typeof value === "string" && isTheme(value)) setTheme(value);
              }}
            >
              {THEMES.map((t) => (
                <Toggle key={t.value} value={t.value}>
                  {t.label}
                </Toggle>
              ))}
            </ToggleGroup>
          </Field>
          <Field label="Events">
            <Events />
          </Field>
          <Button size="compact" variant="outline" onClick={reset}>
            Reset state and preferences
          </Button>
        </div>
      ) : null}
      <Button
        aria-label={open ? "Hide prototype controls" : "Show prototype controls"}
        size="compact"
        variant="glass"
        className="pointer-events-auto"
        onClick={() => setOpen((v) => !v)}
      >
        <SlidersHorizontalIcon aria-hidden />
        Prototype
      </Button>
    </div>
  );
}
