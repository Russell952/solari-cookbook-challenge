/**
 * Persistence factory.
 *
 * Chooses the durable backend from configuration:
 *   MONGODB_URI set  → MongoDB (durable; production)
 *   MONGODB_URI unset → none — the in-memory store IS the state (dev/tests)
 *
 * Production never silently falls back: validateConfig() refuses to boot
 * production without MONGODB_URI, so `createDurableBackend()` in production
 * either returns Mongo or throws.
 *
 * The durable backend carries two things: the UserRepository (accounts are
 * always read through it — single indexed queries, never cached across
 * processes) and the raw document surface (write-through + hydration for
 * the facade's cached domain state).
 */
import { config, isProduction, isMongoConfigured } from "../config/index.js";
import type { DurableBackend } from "./types.js";
import { MongoPersistence } from "./mongo.js";

let instance: DurableBackend | null = null;

export async function createDurableBackend(): Promise<DurableBackend> {
  if (instance) return instance;
  if (isMongoConfigured()) {
    const mongo = new MongoPersistence(config.mongodbUri, config.mongodbDbName);
    try {
      await mongo.init();
      instance = mongo;
      console.log(
        `🗄️  Probe persistence: MongoDB (db=${config.mongodbDbName}) — durable across restarts`
      );
    } catch (err) {
      // Graceful startup failure with a CLEAR error — no silent fallback to
      // ephemeral state in production. The message never contains the URI.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `MongoDB connection failed (db=${config.mongodbDbName}). ` +
          `Refusing to start on ephemeral state. ` +
          `Check MONGODB_URI / network access. Cause: ${msg}`
      );
    }
  } else {
    if (isProduction) {
      // validateConfig should have caught this; belt-and-braces.
      throw new Error("MONGODB_URI is required in production");
    }
    console.log("🗄️  Probe persistence: in-memory (dev) — state resets on restart");
  }
  return instance as DurableBackend;
}

/** Test helper: swap the singleton (or reset it with null). */
export function setDurableBackend(p: DurableBackend | null): void {
  instance = p;
}

export function getDurableBackendSync(): DurableBackend | null {
  return instance;
}
