import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { CommandId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { prepareDispatchCommand } from "./Normalizer.ts";

const layer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest("/tmp", { prefix: "t3-separate-test-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "defers separate project creation and passes canonical identity as literal arguments",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const launcher = `${config.baseDir}/launcher`;
      const output = `${config.baseDir}/arguments`;
      yield* fs.writeFileString(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" > '${output}'\n`);
      yield* fs.chmod(launcher, 0o700);
      const root = `${config.baseDir}/fresh project`;
      const prepared = yield* prepareDispatchCommand({
        type: "project.create",
        commandId: CommandId.make("c1"),
        projectId: ProjectId.make("p1"),
        title: "Fresh",
        workspaceRoot: root,
        separateEnvironment: true,
        createdAt: "2026-09-07T00:00:00.000Z",
      }).pipe(
        Effect.provideService(HostProcessEnvironment, { T3CODE_EXECUTION_LAUNCHER: launcher }),
      );
      expect(yield* fs.exists(output)).toBe(false);
      yield* prepared.performDeferredPreprocessing;
      expect(yield* fs.readFileString(output)).toBe(`create\n${root}\n--project-id\np1\n`);
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects an unsupported host without creating a normal project directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const root = `${config.baseDir}/fresh`;
    const prepared = yield* prepareDispatchCommand({
      type: "project.create",
      commandId: CommandId.make("c2"),
      projectId: ProjectId.make("p2"),
      title: "Fresh",
      workspaceRoot: root,
      separateEnvironment: true,
      createdAt: "2026-09-07T00:00:00.000Z",
    }).pipe(Effect.provideService(HostProcessEnvironment, {}));
    const result = yield* Effect.result(prepared.performDeferredPreprocessing);
    expect(result._tag).toBe("Failure");
    expect(yield* fs.exists(root)).toBe(false);
  }).pipe(Effect.provide(layer)),
);
