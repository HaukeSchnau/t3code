export interface ProductionBrowserSubmissionEvidence {
  readonly localAcceptanceMs: number;
  readonly commandId: string;
  readonly text: string;
}

export interface ProductionBrowserDriver<Control> {
  readonly navigate: (url: string) => Promise<void>;
  readonly assertProductionSurface: (selectors: {
    readonly composer: string;
    readonly cachedTimeline: string;
    readonly connectionStatus: string;
    readonly durableIntent: string;
  }) => Promise<void>;
  readonly cachedContentNonblank: (selector: string) => Promise<boolean>;
  readonly submitComposer: (input: {
    readonly composerSelector: string;
    readonly submitSelector: string;
    readonly durableIntentSelector: string;
    readonly text: string;
  }) => Promise<ProductionBrowserSubmissionEvidence>;
  readonly waitForConnectionStatus: (selector: string, timeoutMs: number) => Promise<number>;
  readonly waitForRecovery: (selector: string, timeoutMs: number) => Promise<number>;
  readonly reload: () => Promise<void>;
  readonly applyControl: (
    control: Control,
    decisionToken: string,
  ) => Promise<{ readonly decisionToken: string; readonly effectiveControl: Control }>;
  readonly traffic: () => {
    readonly bytesSent: number;
    readonly bytesReceived: number;
    readonly requestCount: number;
    readonly eventCount: number;
  };
  readonly close: () => Promise<{ readonly complete: boolean; readonly details: string }>;
}
