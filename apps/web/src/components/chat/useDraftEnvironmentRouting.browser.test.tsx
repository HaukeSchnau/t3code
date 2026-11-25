import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";
import { appAtomRegistry, AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { draftFanoutSelectionsAtom } from "./chatViewSend";

const resources = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => resources.projects,
  readProject: (ref: { environmentId: EnvironmentId; projectId: ProjectId }) =>
    resources.projects.find(
      (project) => project.environmentId === ref.environmentId && project.id === ref.projectId,
    ) ?? null,
}));
vi.mock("../../hooks/useScratchProject", () => ({ useScratchProject: () => ({}) }));

function setup() {
  resources.projects = [];
  const a = EnvironmentId.make("machine-a");
  const b = EnvironmentId.make("machine-b");
  const draftId = DraftId.make("fresh-routing-draft");
  const projectId = ProjectId.make("project");
  const store = useComposerDraftStore.getState();
  store.clearDraftThread(draftId);
  store.setProjectDraftThreadId(scopeProjectRef(a, projectId), draftId, {
    environmentSelection: "auto",
    loadBalancedEnvironmentId: a,
  });
  store.setPrompt(draftId, "Keep this prompt");
  const input: Parameters<typeof useDraftEnvironmentRouting>[0] = {
    draftId,
    envLocked: false,
    automaticEnvironment: true,
    placementPreview: { data: undefined, refresh: () => {} } as unknown as Parameters<
      typeof useDraftEnvironmentRouting
    >[0]["placementPreview"],
    placementStaysHere: false,
    sourceEnvironmentLabel: null,
    logicalProjectEnvironments: [a, b].map((environmentId) => ({
      environmentId,
      projectId,
      label: environmentId,
      isPrimary: environmentId === a,
      machine: "desktop",
    })),
    activeProjectKey: "project",
    activeProjectIsScratch: false,
    projectGroupingSettings: DEFAULT_UNIFIED_SETTINGS,
    sendInFlightRef: { current: false },
  };
  return { a, b, draftId, input, store };
}

interface HarnessProps {
  input: Parameters<typeof useDraftEnvironmentRouting>[0];
}

function Harness(props: HarnessProps) {
  return (
    <AppAtomRegistryProvider>
      <RoutingProbe {...props} />
    </AppAtomRegistryProvider>
  );
}

function RoutingProbe({ input }: HarnessProps) {
  const routing = useDraftEnvironmentRouting(input);
  const draft = useComposerDraftStore((state) => state.getDraftSession(input.draftId!));
  const selections = useAtomValue(
    draftFanoutSelectionsAtom(
      scopedThreadKey(scopeThreadRef(draft!.environmentId, draft!.threadId)),
    ),
  );
  return (
    <>
      <output>
        {selections?.map((selection) => selection.model).join(", ") ?? "single model"}
      </output>
      {input.logicalProjectEnvironments.map(({ environmentId }) => (
        <button
          key={environmentId}
          onClick={() => routing.onEnvironmentChangeStable(environmentId)}
        >
          Switch to {environmentId}
        </button>
      ))}
      <span>{draft?.environmentId}</span>
    </>
  );
}

function fanoutSetup() {
  const routing = setup();
  const { a, b, draftId, store } = routing;
  resources.projects = [a, b].map((environmentId) => ({
    environmentId,
    id: store.getDraftSession(draftId)!.projectId,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-10T01:00:00.000Z",
    updatedAt: "2026-11-10T01:00:00.000Z",
  }));
  const threadId = store.getDraftSession(draftId)!.threadId;
  const selectionsOn = (environmentId: EnvironmentId) =>
    draftFanoutSelectionsAtom(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  const models = (...names: string[]) =>
    names.map((model) => createModelSelection(ProviderInstanceId.make("codex"), model));
  appAtomRegistry.set(selectionsOn(b), null);
  appAtomRegistry.set(selectionsOn(a), models("gpt-6.1-sol", "gpt-6.1-luna"));
  store.setDraftThreadContext(draftId, {
    environmentSelection: "manual",
    loadBalancedEnvironmentId: null,
    branch: "main",
    envMode: "worktree",
  });
  return { ...routing, selectionsOn, models };
}

it("keeps the selected models when the draft switches machine by hand", async () => {
  const { a, b, draftId, input, store, selectionsOn, models } = fanoutSetup();
  await using screen = await render(<Harness input={{ ...input, automaticEnvironment: false }} />);
  await expect.element(screen.getByText("gpt-6.1-sol, gpt-6.1-luna")).toBeInTheDocument();
  await screen.getByRole("button", { name: `Switch to ${b}` }).click();
  await expect.element(screen.getByText(b)).toBeInTheDocument();
  await expect.element(screen.getByText("gpt-6.1-sol, gpt-6.1-luna")).toBeInTheDocument();
  expect(store.getComposerDraft(draftId)?.prompt).toBe("Keep this prompt");

  // Changes made on the new machine come back with the draft.
  await act(async () => appAtomRegistry.set(selectionsOn(b), models("gpt-6.1-sol")));
  await screen.getByRole("button", { name: `Switch to ${a}` }).click();
  await expect.element(screen.getByText(a)).toBeInTheDocument();
  await expect.element(screen.getByText("gpt-6.1-sol", { exact: true })).toBeInTheDocument();
});

it.each([
  { name: "takes the destination default", explicit: false, remoteDefault: true, model: "luna" },
  { name: "keeps a model the user picked", explicit: true, remoteDefault: true, model: "sol" },
  {
    name: "keeps the last-used model without a default",
    explicit: false,
    remoteDefault: false,
    model: "sol",
  },
])("$name when the draft switches machine by hand", async ({ explicit, remoteDefault, model }) => {
  const { b, draftId, input, store } = fanoutSetup();
  const codex = ProviderInstanceId.make("codex");
  resources.projects = resources.projects.map((project) =>
    project.environmentId === b && remoteDefault
      ? { ...project, defaultModelSelection: createModelSelection(codex, "luna") }
      : project,
  );
  store.setStickyModelSelection(createModelSelection(codex, "sol"));
  store.setModelSelection(draftId, createModelSelection(codex, "sol"), { explicit });
  await using screen = await render(<Harness input={{ ...input, automaticEnvironment: false }} />);
  await screen.getByRole("button", { name: `Switch to ${b}` }).click();
  await expect.element(screen.getByText(b)).toBeInTheDocument();
  const draft = store.getComposerDraft(draftId);
  expect(draft?.activeProvider).toBe(codex);
  expect(draft?.modelSelectionByProvider[codex]?.model).toBe(model);
  expect(draft?.modelSelectionExplicit === true).toBe(explicit);
});
