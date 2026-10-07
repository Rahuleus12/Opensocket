import { homedir } from "node:os";
import { loadConfig } from "./env.ts";
import { startServer } from "./server.ts";

const cfg = loadConfig();
cfg.dataDir = cfg.dataDir.replace("~", homedir());
const server = await startServer(cfg);

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
