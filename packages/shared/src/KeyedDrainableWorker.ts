/**
 * KeyedDrainableWorker - bounded parallelism with strict FIFO ordering per key.
 *
 * Different keys may run concurrently, while a key owns at most one active
 * item. After each item the key is requeued at the tail, preventing a noisy
 * key from monopolizing a worker.
 *
 * @module KeyedDrainableWorker
 */
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface KeyedDrainableWorker<K, A> {
  readonly enqueue: (key: K, item: A) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

interface KeyedDrainableWorkerState<K, A> {
  readonly pendingByKey: Map<K, ReadonlyArray<A>>;
  readonly queuedKeys: Set<K>;
  readonly activeKeys: Set<K>;
  readonly outstanding: number;
}

export const makeKeyedDrainableWorker = <K, A, E, R>(options: {
  readonly concurrency: number;
  readonly process: (item: A, key: K) => Effect.Effect<void, E, R>;
  /** Replace a queued tail when the incoming item makes it redundant. */
  readonly replacePendingTail?: (pendingTail: A, incoming: A) => boolean;
}): Effect.Effect<KeyedDrainableWorker<K, A>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const readyKeys = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);
    const stateRef = yield* TxRef.make<KeyedDrainableWorkerState<K, A>>({
      pendingByKey: new Map(),
      queuedKeys: new Set(),
      activeKeys: new Set(),
      outstanding: 0,
    });

    const takeNext = TxQueue.take(readyKeys).pipe(
      Effect.flatMap((key) =>
        TxRef.modify(stateRef, (state) => {
          const queuedKeys = new Set(state.queuedKeys);
          queuedKeys.delete(key);
          const pending = state.pendingByKey.get(key);
          if (pending === undefined || pending.length === 0) {
            return [null, { ...state, queuedKeys }] as const;
          }
          const item = pending[0]!;

          const pendingByKey = new Map(state.pendingByKey);
          if (pending.length === 1) {
            pendingByKey.delete(key);
          } else {
            pendingByKey.set(key, pending.slice(1));
          }
          const activeKeys = new Set(state.activeKeys);
          activeKeys.add(key);
          return [
            { key, item },
            { ...state, pendingByKey, queuedKeys, activeKeys },
          ] as const;
        }).pipe(Effect.tx),
      ),
    );

    const finish = (key: K) =>
      TxRef.modify(stateRef, (state) => {
        const activeKeys = new Set(state.activeKeys);
        activeKeys.delete(key);
        const hasPending = state.pendingByKey.has(key);
        if (!hasPending) {
          return [false, { ...state, activeKeys, outstanding: state.outstanding - 1 }] as const;
        }
        const queuedKeys = new Set(state.queuedKeys);
        queuedKeys.add(key);
        return [
          true,
          { ...state, activeKeys, queuedKeys, outstanding: state.outstanding - 1 },
        ] as const;
      }).pipe(
        Effect.flatMap((shouldRequeue) =>
          shouldRequeue ? TxQueue.offer(readyKeys, key) : Effect.void,
        ),
        Effect.tx,
      );

    const runNext = takeNext.pipe(
      Effect.flatMap((next) =>
        next === null
          ? Effect.void
          : options.process(next.item, next.key).pipe(Effect.ensuring(finish(next.key))),
      ),
      Effect.forever,
    );

    const concurrency = Math.max(1, Math.floor(options.concurrency));
    yield* Effect.forEach(Array.from({ length: concurrency }), () => Effect.forkScoped(runNext), {
      discard: true,
    });

    const enqueue: KeyedDrainableWorker<K, A>["enqueue"] = (key, item) =>
      TxRef.modify(stateRef, (state) => {
        const pendingByKey = new Map(state.pendingByKey);
        const pending = pendingByKey.get(key) ?? [];
        const pendingTail = pending.at(-1);
        const replacesPendingTail =
          pendingTail !== undefined && options.replacePendingTail?.(pendingTail, item) === true;
        pendingByKey.set(
          key,
          replacesPendingTail ? [...pending.slice(0, -1), item] : [...pending, item],
        );
        if (state.activeKeys.has(key) || state.queuedKeys.has(key)) {
          return [
            false,
            {
              ...state,
              pendingByKey,
              outstanding: state.outstanding + (replacesPendingTail ? 0 : 1),
            },
          ] as const;
        }
        const queuedKeys = new Set(state.queuedKeys);
        queuedKeys.add(key);
        return [
          true,
          {
            ...state,
            pendingByKey,
            queuedKeys,
            outstanding: state.outstanding + (replacesPendingTail ? 0 : 1),
          },
        ] as const;
      }).pipe(
        Effect.flatMap((shouldOffer) =>
          shouldOffer ? TxQueue.offer(readyKeys, key) : Effect.void,
        ),
        Effect.tx,
        Effect.asVoid,
      );

    const drain: KeyedDrainableWorker<K, A>["drain"] = TxRef.get(stateRef).pipe(
      Effect.tap((state) => (state.outstanding > 0 ? Effect.txRetry : Effect.void)),
      Effect.asVoid,
      Effect.tx,
    );

    return { enqueue, drain } satisfies KeyedDrainableWorker<K, A>;
  });
