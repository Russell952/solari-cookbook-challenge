/**
 * Probe server entry point.
 *
 * Express server with CORS, JSON parsing, and API routes.
 * All Solari and AI calls happen server-side.
 */
import { config, validateConfig } from "./config/index.js";
import { buildApp } from "./app.js";
import { closeAllClients } from "./solari/index.js";

const app = buildApp();

// Start server
async function main() {
  try {
    validateConfig();
  } catch (e) {
    console.warn("⚠️  Config warning:", (e as Error).message);
    console.warn("   Some features may not work without SOLARI_API_KEY");
  }

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`🔍 Probe server running on http://0.0.0.0:${config.port}`);
  });
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  await closeAllClients();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  await closeAllClients();
  process.exit(0);
});

main();
