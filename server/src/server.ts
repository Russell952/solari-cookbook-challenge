/**
 * Probe server entry point.
 *
 * Express server with CORS, JSON parsing, and API routes.
 * All Solari and AI calls happen server-side.
 *
 * Startup order:
 *   1. validateConfig() — fail fast on missing required production env
 *   2. createDurableBackend() — connect MongoDB when configured, or
 *      stay in-memory for local dev
 *   3. useDurableBackend() — bind the store facade to the backend
 *   4. hydrate() — load durable state into the in-process cache
 *   5. preloadUsers() — warm the session-user TTL cache
 *   6. listen()
 */
import { config, validateConfig } from "./config/index.js";
import { buildApp } from "./app.js";
import { closeAllClients } from "./solari/index.js";
import { preloadUsers } from "./auth/users.js";
import { createDurableBackend } from "./persistence/index.js";
import { useDurableBackend, hydrate, flushAll } from "./store/index.js";

const app = buildApp();

// Start server
async function main() {
  try {
    validateConfig();
  } catch (e) {
    console.warn("⚠️  Config warning:", (e as Error).message);
    console.warn("   Some features may not work without SOLARI_API_KEY");
  }

  // ── Durable persistence (MongoDB in production) ──────────────────────
  // In dev without MONGODB_URI this returns null — the in-process cache
  // IS the store (matches historical behavior). In production it connects
  // to MongoDB or refuses to start (validateConfig already enforced the
  // requirement when MONGODB_URI is missing).
  try {
    const backend = await createDurableBackend();
    useDurableBackend(backend);
    await hydrate();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ Persistence initialization failed: ${msg}`);
    // In production this is fatal (validateConfig already requires
    // MONGODB_URI); in dev we continue with in-memory state.
    if (process.env.NODE_ENV === "production") {
      process.exit(1);
    }
  }

  // Load existing accounts into the session-lookup cache before listening
  // (requireAuth verifies a session's user exists, synchronously).
  await preloadUsers();

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`🔍 Probe server running on http://0.0.0.0:${config.port}`);
  });
}

// Graceful shutdown — flush durable writes before exit.
async function gracefulShutdown(signal: string) {
  console.log(`${signal} received — shutting down...`);
  try {
    await flushAll();
  } catch {
    /* best-effort: flush errors are logged per-collection */
  }
  await closeAllClients();
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

main();
