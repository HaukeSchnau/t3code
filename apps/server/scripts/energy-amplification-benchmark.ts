import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as References from "effect/References";

import {
  runEnergyAmplificationScenario,
  type EnergyAmplificationScenarioOptions,
} from "../integration/EnergyAmplificationHarness.integration.ts";

function parsePositiveInteger(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive safe integer.`);
  }
  return parsed;
}

function parseOptions(argv: ReadonlyArray<string>): EnergyAmplificationScenarioOptions {
  const options: {
    providerChunkCount?: number;
    commandOutputBytes?: number;
    terminalState?: "completed" | "interrupted";
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--chunks") {
      options.providerChunkCount = parsePositiveInteger(argument, argv[++index]);
      continue;
    }
    if (argument === "--bytes") {
      options.commandOutputBytes = parsePositiveInteger(argument, argv[++index]);
      continue;
    }
    if (argument === "--terminal") {
      const terminal = argv[++index];
      if (terminal !== "completed" && terminal !== "interrupted") {
        throw new Error("--terminal must be 'completed' or 'interrupted'.");
      }
      options.terminalState = terminal;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const program = runEnergyAmplificationScenario(options).pipe(
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.provide(NodeServices.layer),
  );
  const originalConsoleLog = console.log;
  console.log = () => undefined;
  const metrics = await Effect.runPromise(program).finally(() => {
    console.log = originalConsoleLog;
  });
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
}
