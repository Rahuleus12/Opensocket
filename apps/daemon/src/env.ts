export interface Config {
  port: number;
  /** Shared secret for M0. M1 replaces this with pairing + device tokens. */
  daemonToken: string;
  /** Base URL of `orchestra serve` - the first validated harness. */
  orchestraUrl: string;
  /** Base URL of `opencode serve` - adapter is WIP (TODO(M0)). */
  opencodeUrl: string;
  /** pi binary (global npm install of @earendil-works/pi-coding-agent). */
  piBin: string;
  /** Built-in agent provider (OpenAI-compatible). Defaults suit the mock. */
  builtinBaseUrl: string;
  builtinApiKey: string;
  builtinModel: string;
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
    piBin: env.PI_BIN ?? "pi",
    builtinBaseUrl: env.BUILTIN_BASE_URL ?? "http://127.0.0.1:8082/v1",
    builtinApiKey: env.BUILTIN_API_KEY ?? "mock-not-needed",
    builtinModel: env.BUILTIN_MODEL_BUILTIN ?? env.BUILTIN_MODEL ?? "mock-gpt",
    defaultModel: env.OPENSOCKET_MODEL,
    dataDir: env.OPENSOCKET_DATA ?? "~/.opensocket",
  };
}
