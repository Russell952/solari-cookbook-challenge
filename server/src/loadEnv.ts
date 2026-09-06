/**
 * Environment preload — loaded via `--import` before the main entry point.
 * Ensures process.env is populated before config/index.ts evaluates.
 */
import { config } from "dotenv";
import { resolve } from "path";

// Load .env first (base), then .env.local (overrides)
config({ path: resolve(process.cwd(), "../.env") });
config({ path: resolve(process.cwd(), "../.env.local"), override: true });
