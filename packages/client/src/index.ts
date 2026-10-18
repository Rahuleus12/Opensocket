/**
 * @opensocket/client — framework-agnostic OSSP client (ADR 0001).
 * Pairing + REST, WebSocket transport (hello-auth, snapshot + tail,
 * auto-resume), SSE fallback. Shared by the daemon web UI's successor,
 * the Tauri companion app, and any future CLI.
 */
export { OpenSocketClient } from "./client.ts";
export type { OpenSocketClientOptions, TransportMode } from "./client.ts";
export { HttpApi } from "./http.ts";
export type {
  DeviceInfo,
  HarnessInfo,
  PairedDevice,
  PairingCode,
  SessionCreateOpts,
  SessionSummary,
} from "./http.ts";
export { streamSse } from "./sse.ts";
export { WsTransport } from "./ws.ts";
export type { WsTransportOptions } from "./ws.ts";
export { HttpError, RpcError } from "./errors.ts";
