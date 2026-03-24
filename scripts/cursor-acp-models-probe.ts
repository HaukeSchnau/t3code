/**
 * Probe: connect to Cursor Agent via ACP (stdio NDJSON JSON-RPC 2.0)
 * and retrieve the available model list.
 *
 * Usage:  bun run scripts/cursor-acp-models-probe.ts
 */

import { spawn, type Subprocess } from "bun"

// ── JSON-RPC helpers ──────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id?: number
  method?: string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
  params?: unknown
}

// ── NDJSON reader ─────────────────────────────────────────────────

async function* readNdjson(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<JsonRpcResponse> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      let nl: number
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.length === 0) continue
        try {
          yield JSON.parse(line) as JsonRpcResponse
        } catch {
          console.error("[probe] unparseable line:", line)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ── Main ──────────────────────────────────────────────────────────

const AGENT_BIN = process.env.CURSOR_AGENT ?? "cursor-agent"
const TIMEOUT_MS = 30_000

console.log(`[probe] spawning: ${AGENT_BIN} acp`)

const proc: Subprocess = spawn([AGENT_BIN, "acp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
})

const writer = proc.stdin!
const messages = readNdjson(proc.stdout as ReadableStream<Uint8Array>)

let nextId = 1

async function send(method: string, params: Record<string, unknown> = {}) {
  const msg: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params,
  }
  const line = JSON.stringify(msg) + "\n"
  writer.write(new TextEncoder().encode(line))
  writer.flush()
  return msg.id
}

async function waitForResponse(
  id: number,
  iter: AsyncGenerator<JsonRpcResponse>,
): Promise<JsonRpcResponse> {
  for await (const msg of iter) {
    // skip notifications (no id)
    if (msg.id === id) return msg
    // log interesting notifications
    if (msg.method) {
      console.log(`[probe] notification: ${msg.method}`)
    }
  }
  throw new Error(`stream ended before response id=${id}`)
}

// ── Run the probe ─────────────────────────────────────────────────

const timeout = setTimeout(() => {
  console.error("[probe] timed out after", TIMEOUT_MS, "ms")
  proc.kill()
  process.exit(1)
}, TIMEOUT_MS)

try {
  // 1. Initialize
  console.log("[probe] → initialize")
  const initId = await send("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "t3-acp-probe", version: "0.1.0" },
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  })
  const initResp = await waitForResponse(initId, messages)
  if (initResp.error) {
    console.error("[probe] initialize error:", initResp.error)
    process.exit(1)
  }
  console.log("[probe] ← initialize response:")
  console.log(JSON.stringify(initResp.result, null, 2))

  const initResult = initResp.result as Record<string, unknown>
  const agentInfo = (initResult.agentInfo ?? initResult.agent_info ?? initResult.serverInfo ?? initResult.server_info) as
    | { name: string; version: string }
    | undefined
  if (agentInfo) {
    console.log(`[probe]   agent: ${agentInfo.name} v${agentInfo.version}`)
  }

  // 2. Create session → models come back in the response
  console.log("[probe] → session/new")
  const sessionId = await send("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  })
  const sessionResp = await waitForResponse(sessionId, messages)
  if (sessionResp.error) {
    console.error("[probe] session/new error:", sessionResp.error)
    process.exit(1)
  }

  const session = sessionResp.result as {
    sessionId: string
    models?: {
      currentModelId: string
      availableModels: Array<{ modelId: string; name: string }>
    }
    configOptions?: Array<{
      id: string
      name: string
      type: string
      currentValue?: string
      options?: Array<{ value: string; name: string }>
    }>
  }

  console.log(`[probe] ← session: ${session.sessionId}`)

  // 3. Print models from top-level models field
  if (session.models) {
    console.log(
      `\n── models (top-level) ── current: ${session.models.currentModelId}`,
    )
    for (const m of session.models.availableModels) {
      console.log(`  ${m.modelId.padEnd(40)} ${m.name}`)
    }
  }

  // 4. Print model config option (may have richer variant info)
  const modelConfig = session.configOptions?.find((c) => c.id === "model")
  if (modelConfig?.options) {
    console.log(
      `\n── models (config option) ── current: ${modelConfig.currentValue}`,
    )
    for (const opt of modelConfig.options) {
      console.log(`  ${opt.value.padEnd(40)} ${opt.name}`)
    }
  }

  // 5. Print other config options for reference
  const otherConfigs = session.configOptions?.filter((c) => c.id !== "model")
  if (otherConfigs?.length) {
    console.log("\n── other config options ──")
    for (const c of otherConfigs) {
      console.log(`  ${c.id}: ${c.currentValue} (${c.type})`)
    }
  }

  // 6. Also dump raw JSON for inspection
  console.log("\n── raw session response ──")
  console.log(JSON.stringify(session, null, 2))
} finally {
  clearTimeout(timeout)
  proc.kill()
}
