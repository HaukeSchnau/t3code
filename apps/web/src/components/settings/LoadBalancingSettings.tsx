import { AuthSettingsWriteScope, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { usePlacementAgentLimits, usePlacementWeights } from "~/hooks/useLoadBalancedEnvironment";
import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import type { MessageResolver } from "~/i18n/messages";
import type { EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { EnvironmentRow, EnvironmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { useSearchableSetting } from "./settingsSearch";

const preferences = [
  { value: 100, label: msg("Prefer") },
  { value: 50, label: msg("Normal", { $context: "load balancing preference" }) },
  { value: 25, label: msg("Less often") },
  { value: 0, label: msg("Manual only") },
] as const;

const summaryLabels = {
  100: msg("{environment} prefer"),
  25: msg("{environment} less often"),
} as const;

type LoadPreference = (typeof preferences)[number]["value"];

function loadPreference(weight: number | null | undefined): LoadPreference {
  if (!weight) return 0;
  if (weight === 50) return 50;
  return weight < 50 ? 25 : 100;
}

function summarizeLoadPreferences(
  environments: ReadonlyArray<EnvironmentPresentation>,
  weights: ReadonlyArray<number | null | undefined>,
  resolve: MessageResolver,
): string {
  const parts = environments.flatMap((environment, index) => {
    const preference = loadPreference(weights[index]);
    if (preference === 0) return [];
    return preference === 50
      ? [environment.label]
      : [resolve(summaryLabels[preference], { environment: environment.label })];
  });
  return parts.length === 0
    ? resolve(msg("Off", { $context: "load balancing is turned off" }))
    : parts.join(" · ");
}

/** The most agents placement starts on a machine at once; empty for no limit. */
function AgentLimitInput({
  label,
  limit,
  disabled,
  onChange,
}: {
  label: string;
  limit: number | null | undefined;
  disabled: boolean;
  onChange: (limit: number | null) => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (limit == null ? "" : String(limit));
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const text = draft.trim();
    // Empty clears the limit; anything but a whole number from 1 to 99 keeps the saved one.
    // Only an emptied field clears it; stray spaces keep the saved limit.
    if (draft !== "" && !/^\d{1,2}$/.test(text)) return;
    const next = text === "" ? null : Number(text);
    if (next === 0) return;
    if (next !== limit) onChange(next);
  };
  return (
    <div className="w-20">
      <Input
        size="sm"
        // Text, so a stray character stays visible instead of reading as an empty, clearing value.
        inputMode="numeric"
        pattern="[0-9]*"
        placeholder={gt("No limit", { $context: "placeholder for an empty agent limit" })}
        aria-label={gt("{environment} agent limit", { environment: label })}
        value={shown}
        disabled={disabled || limit === undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
      />
    </div>
  );
}

function PlacementRow({
  environment,
  weight,
  agentLimit,
}: {
  environment: EnvironmentPresentation;
  weight: number | null | undefined;
  agentLimit: number | null | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const items = preferences.map((entry) => ({ ...entry, label: m(entry.label) }));
  const canWrite = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  return (
    <EnvironmentRow
      kind={resolveEnvironmentMachineKind(environment.serverConfig)}
      label={environment.label}
      subtitle={<EnvironmentTransportLabel environment={environment} />}
    >
      <div className="flex items-center gap-2">
        <AgentLimitInput
          label={environment.label}
          limit={agentLimit}
          disabled={!canWrite}
          onChange={(limit) => updateSettings({ placementAgentLimit: limit })}
        />
        <Select
          items={items}
          value={loadPreference(weight)}
          disabled={weight === undefined || !canWrite}
          onValueChange={(value) => {
            if (value === null) return;
            updateSettings({ placementWeight: value });
          }}
        >
          <SelectTrigger
            size="xs"
            className="w-32"
            aria-label={gt("{environment} load preference", { environment: environment.label })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {items.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
    </EnvironmentRow>
  );
}

export function LoadBalancingSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const searchableSetting = useSearchableSetting();
  const m = useMessages();
  const environmentIds = environments.map((environment) => environment.environmentId);
  const weights = usePlacementWeights(environmentIds);
  const agentLimits = usePlacementAgentLimits(environmentIds);
  if (environments.length < 2) return null;

  const { id, title } = searchableSetting("load-balancing");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={summarizeLoadPreferences(environments, weights, m)}
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        <T>
          New threads on Auto start on the linked machine with the most room for another agent, and
          skip machines under memory pressure or at their agent limit. When none has room, the
          thread waits on the best one. Each machine keeps its own preference and limit, so every
          device sees the same choice.
        </T>
      </p>
      {environments.map((environment, index) => (
        <PlacementRow
          key={environment.environmentId}
          environment={environment}
          weight={weights[index]}
          agentLimit={agentLimits[index]}
        />
      ))}
    </FoldedSettingsSection>
  );
}
