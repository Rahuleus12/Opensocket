import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Device tokens + pairing codes (PLAN §4.4, RFC §8).
 *
 * Pairing: the daemon mints a short-lived, single-use 6-word code (printed to
 * the console, or minted by an already-paired device via POST /api/pair/code).
 * A new device presents the code to POST /api/pair and receives a revocable
 * per-device token. Tokens are stored hashed (sha256); the plaintext exists
 * only in the pair response. The shared DAEMON_TOKEN remains as the loudly
 * dev-only quick-start path.
 *
 * Persistence: <dataDir>/devices.json (atomic tmp+rename write). Sessions are
 * JSONL (R2); devices are daemon state, not session events.
 */

export interface DeviceRecord {
  id: string;
  name: string;
  /** sha256 hex of the bearer token; the token itself is never stored. */
  tokenHash: string;
  created: string;
  lastSeen: string;
  revoked: boolean;
  /** Proxy-reported identity at pair time (e.g. Tailscale WhoIS login). */
  identity?: string;
}

/** Public projection — never leaves the daemon with the hash. */
export type DevicePublic = Omit<DeviceRecord, "tokenHash">;

const CODE_TTL_MS = 10 * 60 * 1000;
const PAIR_ATTEMPT_WINDOW_MS = 5 * 60 * 1000;
const PAIR_ATTEMPT_MAX = 10;

/** 256 short words: 6 words -> 48 bits of pairing entropy. */
const WORDS = [
  "amber", "anchor", "apple", "arrow", "atlas", "aurora", "autumn", "azure",
  "bamboo", "basalt", "beacon", "berry", "birch", "bison", "blaze", "bloom",
  "brass", "breeze", "bridge", "bronze", "brook", "bubble", "cactus", "canyon",
  "cedar", "chalk", "cherry", "chisel", "cinder", "citrus", "clover", "cobalt",
  "comet", "copper", "coral", "cosmos", "cotton", "crane", "crater", "creek",
  "crisp", "crystal", "cyclone", "dahlia", "delta", "denim", "diesel", "dingo",
  "dolphin", "domino", "dragon", "dune", "eagle", "ember", "emerald", "engine",
  "falcon", "fern", "fjord", "flame", "flint", "flor", "forest", "fossil",
  "fountain", "fox", "frost", "galaxy", "garnet", "gecko", "gem", "glacier",
  "glide", "granite", "graph", "gravel", "harbor", "hawk", "hazel", "helix",
  "heron", "hollow", "honey", "horizon", "indigo", "iris", "ivory", "jade",
  "jasper", "jungle", "juniper", "kayak", "kernel", "kingdom", "kite", "koala",
  "lagoon", "lantern", "lattice", "lava", "leaf", "ledge", "lemon", "leopard",
  "lilac", "linen", "lotus", "lumen", "lunar", "lynx", "magnet", "mango",
  "maple", "marble", "meadow", "mercury", "meteor", "mint", "mirage", "moss",
  "nebula", "nectar", "nickel", "nimbus", "noble", "north", "oak", "oasis",
  "obsidian", "ocean", "olive", "onyx", "opal", "orbit", "orchid", "osprey",
  "otter", "palm", "panda", "pebble", "pepper", "petal", "phoenix", "pigment",
  "pine", "pistol", "pixel", "plateau", "plume", "polar", "pollen", "prairie",
  "prism", "pumice", "quartz", "quasar", "quill", "radar", "rain", "raven",
  "reef", "ridge", "ripple", "river", "rocket", "rust", "saffron", "sage",
  "sailor", "salmon", "sandal", "sapphire", "scarf", "sequoia", "shale", "shore",
  "signal", "silk", "silver", "siren", "slate", "solar", "sonnet", "spark",
  "spruce", "star", "stone", "storm", "summit", "sunset", "tanger", "teak",
  "tempest", "thistle", "tiger", "timber", "topaz", "torch", "tower", "trail",
  "tundra", "tulip", "turbine", "umbra", "urchin", "valley", "velvet", "vertex",
  "violet", "vista", "walnut", "warbler", "water", "wicker", "willow", "winter",
  "wolf", "wren", "yarrow", "zenith", "zephyr", "zinc", "zircon", "horst",
];

interface PairCode {
  code: string;
  expiresAt: number;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class DeviceStore {
  private devices: DeviceRecord[] = [];
  private codes = new Map<string, PairCode>();
  private attempts = new Map<string, { count: number; resetAt: number }>();
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private lastSeenDirty = false;

  constructor(dataDir: string) {
    this.file = join(dataDir, "devices.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as { devices?: DeviceRecord[] };
      this.devices = Array.isArray(parsed.devices) ? parsed.devices : [];
    } catch {
      this.devices = []; // no file yet (or unreadable): start empty
    }
  }

  private async save(): Promise<void> {
    await mkdir(join(this.file, ".."), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, devices: this.devices }, null, 2), "utf8");
    await rename(tmp, this.file);
  }

  /** Debounced save for lastSeen updates (avoid a write per request). */
  private scheduleSave(): void {
    this.lastSeenDirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.lastSeenDirty) return;
      this.lastSeenDirty = false;
      void this.save().catch((err) => console.log(`[devices] save failed: ${String(err).slice(0, 120)}`));
    }, 5_000);
  }

  get count(): number {
    return this.devices.filter((d) => !d.revoked).length;
  }

  list(): DevicePublic[] {
    return this.devices.map(({ tokenHash: _ignored, ...rest }) => rest);
  }

  /** Constant-ish-time verify by comparing the full hash. */
  verify(token: string): DeviceRecord | null {
    if (!token) return null;
    const h = hashToken(token);
    const hit = this.devices.find((d) => !d.revoked && d.tokenHash === h);
    if (!hit) return null;
    hit.lastSeen = new Date().toISOString();
    this.scheduleSave();
    return hit;
  }

  /** Mint a short-lived, single-use pairing code. */
  mintCode(ttlMs = CODE_TTL_MS): { code: string; expiresAt: number } {
    const words: string[] = [];
    const bytes = randomBytes(12); // 6 words x 8 bits
    for (let i = 0; i < 6; i++) words.push(WORDS[bytes[i] % WORDS.length]);
    const code = words.join(" ");
    const expiresAt = Date.now() + ttlMs;
    this.codes.set(code, { code, expiresAt });
    // opportunistic cleanup
    const now = Date.now();
    for (const [c, pc] of this.codes) if (pc.expiresAt < now) this.codes.delete(c);
    return { code, expiresAt };
  }

  /** Brute-force throttle per client address. Returns an error string or null. */
  throttle(key: string): string | null {
    const now = Date.now();
    const a = this.attempts.get(key);
    if (!a || a.resetAt < now) {
      this.attempts.set(key, { count: 1, resetAt: now + PAIR_ATTEMPT_WINDOW_MS });
      return null;
    }
    a.count += 1;
    if (a.count > PAIR_ATTEMPT_MAX) return "too many attempts; wait a few minutes";
    return null;
  }

  /**
   * Consume a pairing code and mint a device token. Throws on bad/expired/
   * used codes (the caller maps this to 401/403/429).
   */
  async pair(code: string, name: string, identity?: string): Promise<{ device: DevicePublic; token: string }> {
    const normalized = code.trim().toLowerCase().replace(/\s+/g, " ");
    const pc = this.codes.get(normalized);
    if (!pc) throw new Error("unknown pairing code");
    if (pc.expiresAt < Date.now()) {
      this.codes.delete(normalized);
      throw new Error("pairing code expired");
    }
    this.codes.delete(normalized); // single use
    const token = randomBytes(32).toString("hex");
    const device: DeviceRecord = {
      id: `dev_${randomUUID().slice(0, 13)}`,
      name: name.trim().slice(0, 60) || "unnamed device",
      tokenHash: hashToken(token),
      created: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      revoked: false,
      ...(identity ? { identity } : {}),
    };
    this.devices.push(device);
    await this.save();
    const { tokenHash: _ignored, ...pub } = device;
    return { device: pub, token };
  }

  revoke(id: string): boolean {
    const hit = this.devices.find((d) => d.id === id && !d.revoked);
    if (!hit) return false;
    hit.revoked = true;
    void this.save();
    return true;
  }
}
