export interface Config {
  port: number;
  /** Shared secret for M0. M1 replaces this with pairing + device tokens. */
  daemonToken: string;
  /** Base URL of `orchestra serve` - the first validated harness. */
  orchestraUrl: string;
  /** Base URL of `opencode serve` - adapter verified against v2.0.32. */
  opencodeUrl: string;
  /** Password for `opencode serve` (its OPENCODE_PASSWORD env). */
  opencodePassword: string;
  /** pi binary (global npm install of @earendil-works/pi-coding-agent). */
  piBin: string;
  /** Built-in agent provider (OpenAI-compatible). Defaults to env key. */
  builtinBaseUrl: string;
  builtinApiKey: string;
  builtinModel: string;
  /** Approval ask timeout (R3); silence auto-denies. */
  approvalTimeoutMs?: number;
  /** ntfy topic URL for push notifications (e.g. https://ntfy.sh/my-topic). */
  ntfyUrl?: string;
  /** Bearer token for authenticated (self-hosted) ntfy servers. */
  ntfyToken?: string;
  /** Fallback model for new sessions when the client sends none. */
  defaultModel?: string;
  /** Root for JSONL session storage. */
  dataDir: string;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): Config {
  return {
    port: Number(env.PORT ?? 8097),
    daemonToken: env.DAEMON_TOKEN ?? "",
    orchestraUrl: env.ORCHESTRA_URL ?? "http://127.0.0.1:8080",
    opencodeUrl: env.OPENCODE_URL ?? "http://127.0.0.1:4096",
    opencodePassword: env.OPENCODE_PASSWORD ?? "",
    piBin: env.PI_BIN ?? "pi",
    // Built-in agent: default to the env's OpenRouter key when present (R4:
    // provider choice stays in the harness), else the local mock.
    builtinApiKey: env.BUILTIN_API_KEY ?? env.OPENROUTER_API_KEY ?? "mock-not-needed",
    builtinBaseUrl:
      env.BUILTIN_BASE_URL ?? (env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1" : "http://127.0.0.1:8082/v1"),
    builtinModel: env.BUILTIN_MODEL ?? (env.OPENROUTER_API_KEY ? "openai/gpt-4o" : "mock-gpt"),
    approvalTimeoutMs: env.OPENSOCKET_APPROVAL_TIMEOUT_MS ? Number(env.OPENSOCKET_APPROVAL_TIMEOUT_MS) : undefined,
    ntfyUrl: env.NTFY_URL,
    ntfyToken: env.NTFY_TOKEN,
    defaultModel: env.OPENSOCKET_MODEL,
    dataDir: env.OPENSOCKET_DATA ?? "~/.opensocket",
  };
}
