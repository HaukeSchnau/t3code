import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Librarian from "../../../librarian/Librarian.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { LibrarianToolkit } from "./tools.ts";

const toFailure = (error: Librarian.LibrarianError) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "LibrarianUnavailableError" || error._tag === "ForgeRawFileError"
        ? "orchestration_error"
        : "invalid_request",
    message: error.message,
  });

const handlers = {
  librarian_search: McpToolAccess.reads((input) =>
    Effect.flatMap(Librarian.Librarian, (librarian) => librarian.search(input)).pipe(
      Effect.mapError(toFailure),
    ),
  ),
  librarian_read_file: McpToolAccess.reads((input) =>
    Effect.flatMap(Librarian.Librarian, (librarian) => librarian.readFile(input)).pipe(
      Effect.mapError(toFailure),
    ),
  ),
  librarian_list_repos: McpToolAccess.reads((input) =>
    Effect.flatMap(Librarian.Librarian, (librarian) => librarian.listRepos(input)).pipe(
      Effect.mapError(toFailure),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof LibrarianToolkit.tools>;

export const layer = McpToolAccess.toLayer(LibrarianToolkit, handlers);
