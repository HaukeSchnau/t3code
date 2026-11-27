/**
 * Fork (patches/bounded-traces.md): a span whose parent has ended, or whose trace started here
 * more than `MAX_TRACE_AGE_MS` ago, starts a new trace linked to that parent. Background loops,
 * followers and subscriptions would otherwise add to one trace for as long as they run, and
 * Tempo keeps a trace in memory while its spans keep arriving.
 */
import type * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

const MAX_TRACE_AGE_MS = 10 * 60_000;

/** The tracer's span, with when this process started its trace on a monotonic clock. */
class BoundedSpan implements Tracer.Span {
  readonly _tag = "Span";
  private readonly span: Tracer.Span;
  readonly traceStartedAt: number;
  constructor(span: Tracer.Span, traceStartedAt: number) {
    this.span = span;
    this.traceStartedAt = traceStartedAt;
  }
  get name() {
    return this.span.name;
  }
  get spanId() {
    return this.span.spanId;
  }
  get traceId() {
    return this.span.traceId;
  }
  get parent() {
    return this.span.parent;
  }
  get annotations() {
    return this.span.annotations;
  }
  get status() {
    return this.span.status;
  }
  get attributes() {
    return this.span.attributes;
  }
  get links() {
    return this.span.links;
  }
  get sampled() {
    return this.span.sampled;
  }
  get kind() {
    return this.span.kind;
  }
  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>) {
    this.span.end(endTime, exit);
  }
  attribute(key: string, value: unknown) {
    this.span.attribute(key, value);
  }
  event(name: string, startTime: bigint, attributes?: Record<string, unknown>) {
    this.span.event(name, startTime, attributes);
  }
  addLinks(links: ReadonlyArray<Tracer.SpanLink>) {
    this.span.addLinks(links);
  }
}

// Span start times read 0 when trace timing is off, so trace age comes from its own clock.
export const boundTraces = (
  tracer: Tracer.Tracer,
  now: () => number = () => performance.now(),
): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const parent = Option.getOrUndefined(options.parent);
      const startedAt = now();
      // A root, or a parent from another process (a traceparent header), which keeps its trace.
      if (!(parent instanceof BoundedSpan)) return new BoundedSpan(tracer.span(options), startedAt);
      if (
        parent.status._tag === "Started" &&
        startedAt - parent.traceStartedAt <= MAX_TRACE_AGE_MS
      ) {
        return new BoundedSpan(tracer.span(options), parent.traceStartedAt);
      }
      const root = tracer.span({
        ...options,
        parent: Option.none(),
        root: true,
        links: [...options.links, { span: parent, attributes: {} }],
      });
      return new BoundedSpan(root, startedAt);
    },
    ...(tracer.context === undefined ? {} : { context: tracer.context }),
  });
