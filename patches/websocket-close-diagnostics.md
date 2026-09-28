# WebSocket close diagnostics

Connection errors in the client runtime include the WebSocket close code and a trimmed close reason
(at most 160 characters) when the socket closes abnormally. A clean `1000` close adds nothing. This
separates proxy and tunnel failures from server restarts when a remote environment disconnects.

The diagnostics live in `packages/client-runtime/src/rpc/session.ts`, which wraps the WebSocket
constructor to observe the close event. They add no retry, heartbeat or reconnect policy;
`EnvironmentSupervisor` still owns reconnects.

Remove this patch when upstream reports close codes in its transport errors.
