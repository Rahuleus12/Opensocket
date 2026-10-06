import { homedir } from "node:os";
import { loadConfig } from "./env";
import { startServer } from "./server";

const cfg = loadConfig();
cfg.dataDir = cfg.dataDir.replace("~", homedir());
startServer(cfg);
