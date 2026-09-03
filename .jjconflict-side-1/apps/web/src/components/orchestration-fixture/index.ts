/**
 * Public seams for the dev-only orchestration fixture. Its virtual catalog
 * feeds the ordinary project/thread atoms, including the shell's coordination
 * block, while the normal sidebar, thread route, Work panel and Compare
 * surface supply the production shell around fixture-owned transcripts.
 */
export {
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_ENVIRONMENT_LABEL,
  buildFixtureCoordination,
  buildFixtureShellSnapshot,
  fixtureShellSnapshotAtom,
  fixtureThreadKey,
  fixtureThreadRef,
  isFixtureEnvironment,
  startFixtureEnvironmentSync,
  withFixtureCatalog,
  withFixtureSnapshot,
} from "./fixtureEnvironment";
export {
  FixtureNavigationContext,
  useFixtureActions,
  useFixtureNavigation,
  type FixtureNavigation,
} from "./actions";
export { FixtureChatView } from "./FixtureChatView";
export { StepStrip } from "./StepStrip";
export { OrchestrationFixturePage } from "./OrchestrationFixturePage";
export {
  readFixtureState,
  selectFixtureState,
  useFixtureState,
  useOrchestrationFixtureStore,
} from "./store";
export { COORDINATOR_ID, FIXTURE_STEPS } from "./scenario";
export type { FixtureEvent, FixtureState, FixtureStep, FixtureThread } from "./model";
