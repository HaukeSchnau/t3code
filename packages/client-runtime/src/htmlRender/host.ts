import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type HtmlRenderCallToolResult,
  type HtmlRenderContextRecord,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import {
  HTML_RENDER_ACTIVATED_METHOD,
  HTML_RENDER_CALL_TOOL_METHOD,
  HTML_RENDER_COPY_METHOD,
  HTML_RENDER_SEND_METHOD,
  HTML_RENDER_STORAGE_MAX_BYTES,
  HTML_RENDER_STORAGE_METHOD,
} from "@t3tools/shared/htmlRender";
import * as Predicate from "effect/Predicate";

const MAX_PENDING_REQUESTS = 4;
// Page script can post the activated notice itself while a click's transient activation lasts
// (about 5 s), and the host cannot tell it from the bootstrap's. Every notice earns credit, so quick
// real clicks all work. Messages, the one action nothing else gates, are capped at 3 per 5 s;
// tools that change things ask first, and the server rate-limits tool calls.
const MESSAGE_WINDOW_MS = 5_000;
const MAX_MESSAGES_PER_WINDOW = 3;
const encoder = new TextEncoder();

type JsonRpcId = string | number;

export class HtmlRenderHostRefusal extends Error {}

/** A render shown in a thread; pages elsewhere only get `copy`. */
export interface HtmlRenderBridgeTarget {
  readonly renderId: string;
  readonly title: string;
  readonly send: (message: {
    readonly text: string;
    readonly context: OrchestrationMessageContext;
  }) => Promise<void>;
  readonly callTool: (input: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    readonly confirmed: boolean;
  }) => Promise<HtmlRenderCallToolResult>;
  readonly confirm: (request: {
    readonly page: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  }) => Promise<boolean>;
  /** Undefined for viewers who may read the state but not change it, such as guests. */
  readonly saveState: ((state: Readonly<Record<string, string>>) => void) | undefined;
}

export interface HtmlRenderHostOptions {
  readonly post: (message: unknown) => void;
  readonly copy: (text: string) => Promise<void>;
  readonly bridge: HtmlRenderBridgeTarget | undefined;
  /** Milliseconds; defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface HtmlRenderHost {
  /**
   * Handles one message the page posted; the caller has already checked its source. `active`
   * means the reader is using the frame now: it is focused and has transient user activation.
   */
  readonly receive: (data: unknown, activity: { readonly active: boolean }) => void;
  readonly dispose: () => void;
}

/** The text carries a reference to the record, so the agent and the chip both see the page. */
function htmlRenderMessage(
  render: Pick<HtmlRenderBridgeTarget, "renderId" | "title">,
  text: string,
): { readonly text: string; readonly context: OrchestrationMessageContext } {
  const contextId = toKindScopedComposerContextId("html-render", render.renderId);
  const record: HtmlRenderContextRecord = {
    version: 1,
    kind: "html-render",
    contextId,
    label: `From ${render.title}`,
    renderId: render.renderId,
    title: render.title,
  };
  return {
    text: `${formatComposerContextReference(record)} ${text}`,
    context: { version: 1, records: [record] },
  };
}

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim() !== "" ? error.message : "Request failed.";

const isId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

const readState = (value: unknown): Record<string, string> | undefined => {
  if (!Predicate.isObject(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, entry]) => typeof entry === "string") &&
    encoder.encode(JSON.stringify(value)).byteLength <= HTML_RENDER_STORAGE_MAX_BYTES
    ? (Object.fromEntries(entries) as Record<string, string>)
    : undefined;
};

export function makeHtmlRenderHost(options: HtmlRenderHostOptions): HtmlRenderHost {
  let disposed = false;
  let pending = 0;
  // One trusted click in the page buys one send or tool call.
  let clickCredit = false;
  let messages: ReadonlyArray<number> = [];
  const now = options.now ?? Date.now;

  const post = (message: unknown) => {
    if (!disposed) options.post(message);
  };
  const fail = (id: JsonRpcId, code: number, message: string) =>
    post({ jsonrpc: "2.0", id, error: { code, message } });

  const answer = (id: JsonRpcId, run: () => Promise<unknown>) => {
    if (pending >= MAX_PENDING_REQUESTS) {
      fail(id, -32000, "Too many requests in flight.");
      return;
    }
    pending += 1;
    void run().then(
      (result) => {
        pending -= 1;
        post({ jsonrpc: "2.0", id, result: result ?? null });
      },
      (error: unknown) => {
        pending -= 1;
        fail(id, -32000, errorMessage(error));
      },
    );
  };

  const spendClick = (active: boolean) => {
    if (!active || !clickCredit) return false;
    clickCredit = false;
    return true;
  };

  const recentMessages = () => {
    const at = now();
    messages = messages.filter((sent) => at - sent < MESSAGE_WINDOW_MS);
    return messages.length;
  };

  const callTool = async (
    bridge: HtmlRenderBridgeTarget,
    name: string,
    args: Record<string, unknown>,
  ) => {
    let result = await bridge.callTool({ name, arguments: args, confirmed: false });
    if (result._tag === "ConfirmationRequired") {
      const allowed = await bridge.confirm({
        page: bridge.title,
        tool: result.title,
        arguments: args,
      });
      if (!allowed) throw new HtmlRenderHostRefusal("Declined by the user.");
      result = await bridge.callTool({ name, arguments: args, confirmed: true });
    }
    if (result._tag !== "Completed") throw new HtmlRenderHostRefusal("The tool did not run.");
    if (result.isError) {
      throw new HtmlRenderHostRefusal(
        typeof result.value === "string" && result.value.trim() !== ""
          ? result.value
          : `${name} failed.`,
      );
    }
    return result.value;
  };

  const handleRequest = (
    id: JsonRpcId,
    method: string,
    params: Record<PropertyKey, unknown>,
    active: boolean,
  ) => {
    const bridge = options.bridge;
    switch (method) {
      case HTML_RENDER_COPY_METHOD: {
        if (typeof params.text !== "string") {
          fail(id, -32602, "copy needs text.");
          return;
        }
        if (!active) {
          fail(id, -32000, "Copying needs a click in the page.");
          return;
        }
        const text = params.text;
        answer(id, () => options.copy(text));
        return;
      }
      case HTML_RENDER_SEND_METHOD: {
        const text = typeof params.text === "string" ? params.text.trim() : "";
        if (text === "" || text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
          fail(
            id,
            -32602,
            `send needs text of 1 to ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS} characters.`,
          );
          return;
        }
        if (bridge === undefined) {
          fail(id, -32000, "Only a page shown in a thread can send messages.");
          return;
        }
        if (recentMessages() >= MAX_MESSAGES_PER_WINDOW) {
          fail(id, -32000, "This page sent 3 messages in the last 5 seconds. Wait a moment.");
          return;
        }
        if (!spendClick(active)) {
          fail(id, -32000, "Sending needs a click in the page, one message per click.");
          return;
        }
        messages = [...messages, now()];
        answer(id, () => bridge.send(htmlRenderMessage(bridge, text)));
        return;
      }
      case HTML_RENDER_CALL_TOOL_METHOD: {
        const name = params.name;
        const args = params.arguments ?? {};
        if (typeof name !== "string" || name.trim() === "" || !Predicate.isObject(args)) {
          fail(id, -32602, "callTool needs a tool name and object arguments.");
          return;
        }
        if (bridge === undefined) {
          fail(id, -32000, "Only a page shown in a thread can call tools.");
          return;
        }
        if (!spendClick(active)) {
          fail(id, -32000, "Calling a tool needs a click in the page, one call per click.");
          return;
        }
        answer(id, () => callTool(bridge, name, args as Record<string, unknown>));
        return;
      }
      default:
    }
  };

  return {
    receive: (data, { active }) => {
      if (disposed || !Predicate.isObject(data) || data.jsonrpc !== "2.0") return;
      const method = data.method;
      if (typeof method !== "string") return;
      const params = Predicate.isObject(data.params) ? data.params : {};
      if (isId(data.id)) {
        handleRequest(data.id, method, params, active);
        return;
      }
      if (method === HTML_RENDER_ACTIVATED_METHOD) {
        if (active) clickCredit = true;
        return;
      }
      if (method === HTML_RENDER_STORAGE_METHOD) {
        const state = readState(params.state);
        if (state !== undefined) options.bridge?.saveState?.(state);
      }
    },
    dispose: () => {
      disposed = true;
    },
  };
}
