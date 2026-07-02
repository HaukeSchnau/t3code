// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadWorkspaceService from "./ThreadWorkspaceService.ts";

const TestLayer = ThreadWorkspaceService.layer.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-thread-workspace-service-test-",
    }),
  ),
  Layer.provide(Layer.mock(GitWorkflowService.GitWorkflowService)({})),
  Layer.provideMerge(NodeServices.layer),
);

const layer = it.layer(Layer.fresh(TestLayer));

layer("ThreadWorkspaceService", (it) => {
  it.effect("persists failed directory-copy provisioning for diagnostics", () =>
    Effect.gen(function* () {
      const service = yield* ThreadWorkspaceService.ThreadWorkspaceService;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-directory-copy-failure");
      const missingSourcePath = NodePath.join(
        NodeOS.tmpdir(),
        `t3-missing-source-${process.pid}-directory-copy-failure`,
      );

      const exit = yield* Effect.exit(
        service.prepareWorkspace({
          threadId,
          kind: "directory-copy",
          roots: [
            {
              projectId: ProjectId.make("project-directory-copy-failure"),
              sourcePath: missingSourcePath,
              role: "primary",
            },
          ],
          retentionPolicy: "explicit-delete",
        }),
      );

      assert.equal(Exit.isFailure(exit), true);

      const rows = yield* sql<{
        readonly lifecycle: string;
        readonly failure_detail: string | null;
        readonly metadata_json: string;
      }>`
        SELECT
          lifecycle,
          failure_detail,
          metadata_json
        FROM projection_thread_workspaces
        WHERE id = ${`workspace:${threadId}`}
      `;

      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.lifecycle, "failed");
      assert.ok(rows[0]?.failure_detail);
      assert.match(rows[0]?.metadata_json ?? "", /"preparationStatus":"failed"/);
    }),
  );
});
