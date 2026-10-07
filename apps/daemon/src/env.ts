export interface Config {
  port: number;
  /** Shared secret for M0. M1 replaces this with pairing + device tokens. */
  daemonToken: string;
  /** Base URL of `orchestra serve` - the first validated harness. */
  orchestraUrl: string;
  /** Base URL of `opencode serve` - adapter is WIP (TODO(M0)). */
  opencodeUrl: string;
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
    dataDir: env.OPENSOCKET_DATA ?? "~/.opensocket",
  };
}
