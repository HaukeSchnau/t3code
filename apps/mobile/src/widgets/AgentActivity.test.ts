import { expect, it, vi } from "vite-plus/test";

vi.mock("@expo/ui/swift-ui", () => ({
  HStack: "HStack",
  Image: "Image",
  Spacer: "Spacer",
  Text: "Text",
  VStack: "VStack",
  ZStack: "ZStack",
}));

vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  containerBackground: (color: unknown, container: unknown) => ({
    containerBackground: { color, container },
  }),
  accessibilityElement: (value: unknown) => value,
  accessibilityLabel: (value: unknown) => value,
  activityBackgroundTint: (value: unknown) => value,
  font: (value: unknown) => value,
  foregroundStyle: (value: unknown) => value,
  frame: (value: unknown) => value,
  layoutPriority: (value: unknown) => value,
  lineLimit: (value: unknown) => value,
  minimumScaleFactor: (value: unknown) => value,
  padding: (value: unknown) => value,
  resizable: (value: unknown) => value,
  widgetURL: (value: unknown) => ({ widgetURL: value }),
}));

vi.mock("expo-widgets", () => ({
  createLiveActivity: vi.fn((name: string, layout: unknown) => ({ layout, name })),
  createWidget: vi.fn((name: string, layout: unknown) => ({ layout, name })),
}));

import { AgentActivity } from "./AgentActivity";

// iOS shows "Please adopt containerBackground API" instead of a widget that skips it.
it("adopts WidgetKit's required container background", () => {
  const layout = AgentActivity(
    {
      title: "T3 Code",
      subtitle: "Agent work in progress",
      activeCount: 1,
      updatedAt: "2026-05-25T13:07:00.000Z",
      activities: [
        {
          environmentId: "env-1",
          threadId: "thread-1",
          projectTitle: "Project",
          threadTitle: "Thread",
          modelTitle: "gpt-5.4",
          phase: "running",
          status: "Working",
          updatedAt: "2026-05-25T13:07:00.000Z",
          deepLink: "/threads/env-1/thread-1",
        },
      ],
    },
    {
      date: new Date("2026-05-25T13:07:00.000Z"),
      widgetFamily: "systemMedium",
      colorScheme: "dark",
      isLuminanceReduced: false,
      configuration: undefined,
    } as never,
  );

  expect(JSON.stringify(layout)).toContain(
    '"containerBackground":{"color":"#111827","container":"widget"}',
  );
});
