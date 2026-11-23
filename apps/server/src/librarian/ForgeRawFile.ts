import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

export class ForgeRawFileError extends Schema.TaggedError<ForgeRawFileError>()(
  "ForgeRawFileError",
  {
    host: Schema.String,
    command: Schema.String,
    httpStatus: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.command} could not read the file from ${this.host}${this.httpStatus ? ` (HTTP ${this.httpStatus})` : ""}.`;
  }
}

const decodeTeaLogins = Schema.decodeOption(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String }))),
);

/** Reads one file at a commit through the forge CLI this host is already signed in to. */
export class ForgeRawFile extends Context.Service<
  ForgeRawFile,
  {
    /** `repo` is a forge path without scheme, such as `github.com/owner/name`. */
    readonly read: (input: {
      readonly repo: string;
      readonly ref: string;
      readonly path: string;
    }) => Effect.Effect<string, ForgeRawFileError>;
  }
>()("t3/librarian/ForgeRawFile") {}

const MAX_FILE_BYTES = 64 * 1024 * 1024;

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;

  const run = Effect.fn("ForgeRawFile.run")(function* (
    host: string,
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* runner
      .run({ command, args, maxOutputBytes: MAX_FILE_BYTES, timeout: "60 seconds" })
      .pipe(Effect.mapError((cause) => new ForgeRawFileError({ host, command, cause })));
    if (result.code !== 0) return yield* new ForgeRawFileError({ host, command });
    return result;
  });

  const teaLogin = Effect.fn("ForgeRawFile.teaLogin")(function* (host: string) {
    const result = yield* run(host, "tea", ["logins", "list", "--output", "json"]).pipe(
      Effect.option,
    );
    if (result._tag === "None") return undefined;
    const logins = decodeTeaLogins(result.value.stdout);
    if (logins._tag === "None") return undefined;
    return logins.value.find((login) => URL.parse(login.url)?.host === host);
  });

  const read: ForgeRawFile["Service"]["read"] = Effect.fn("ForgeRawFile.read")(function* (input) {
    const slash = input.repo.indexOf("/");
    const host = input.repo.slice(0, slash);
    const project = input.repo.slice(slash + 1);
    if (host === "github.com") {
      const result = yield* run(host, "gh", [
        "api",
        "-H",
        "Accept: application/vnd.github.raw+json",
        `repos/${project}/contents/${encodePath(input.path)}?ref=${encodeURIComponent(input.ref)}`,
      ]);
      return result.stdout;
    }
    const login = yield* teaLogin(host);
    if (login !== undefined) {
      const base = login.url.replace(/\/+$/, "");
      const result = yield* run(host, "tea", [
        "api",
        "--include",
        "--login",
        login.name,
        `${base}/api/v1/repos/${project}/raw/${encodePath(input.path)}?ref=${encodeURIComponent(input.ref)}`,
      ]);
      // tea exits zero on HTTP errors; --include writes the status line to stderr.
      const status = Number(/^HTTP\/\S+ (\d{3})/m.exec(result.stderr)?.[1]);
      if (!status || status >= 400)
        return yield* new ForgeRawFileError({
          host,
          command: "tea",
          ...(status ? { httpStatus: status } : {}),
        });
      return result.stdout;
    }
    const result = yield* run(host, "glab", [
      "api",
      "--hostname",
      host,
      `projects/${encodeURIComponent(project)}/repository/files/${encodeURIComponent(input.path)}/raw?ref=${encodeURIComponent(input.ref)}`,
    ]);
    return result.stdout;
  });

  return ForgeRawFile.of({ read });
});

export const layer = Layer.effect(ForgeRawFile, make);
