/**
 * Minimal structural types for the runtime globals this client uses
 * (`fetch`, `WebSocket`, `TextDecoder`, `AbortController`), so the package
 * typechecks under a DOM lib, @types/node, or a Tauri webview without
 * committing to either typing.
 *
 * No `node:*` imports — this package runs in any JS runtime with
 * fetch + WebSocket (browsers, Node >= 22, Deno, Bun).
 */

export interface WsMessageEvent {
  data: unknown;
}

export interface WsCloseEvent {
  code: number;
  reason: string;
}

/** The slice of the WebSocket API the client touches. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: WsMessageEvent) => void) | null;
  onclose: ((ev: WsCloseEvent) => void) | null;
  onerror: (() => void) | null;
}

export function openWebSocket(url: string): WsLike {
  const ctor = (globalThis as { WebSocket?: new (url: string) => unknown })
    .WebSocket;
  if (typeof ctor !== "function") {
    throw new Error("WebSocket is not available in this runtime");
  }
  return new ctor(url) as WsLike;
}

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** The slice of the fetch Response the client touches. */
export interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  readonly body: {
    getReader(): {
      read(): Promise<{ done: boolean; value: unknown }>;
    };
  } | null;
}

export async function httpFetch(
  url: string,
  init?: FetchInit,
): Promise<FetchResponse> {
  const g = globalThis as {
    fetch?: (url: string, init?: unknown) => Promise<unknown>;
  };
  if (typeof g.fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }
  return (await g.fetch(url, init)) as FetchResponse;
}
