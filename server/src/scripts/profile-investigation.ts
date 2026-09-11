/**
 * Profiling driver — runs ONE real investigation end-to-end, in-process.
 *
 * Purpose: measure where the Probe investigation pipeline actually spends its
 * runtime (phases, AI calls, browser/Solari ops, evidence, persistence) using
 * the existing budgets — no budget, retry, or behavior changes.
 *
 * Usage (from repo root or server/):
 *   PROBE_PROFILE=1 npx tsx --import ./src/loadEnv.ts src/scripts/profile-investigation.ts \
 *     --repository https://github.com/NorthWorth/Rayern-frontend \
 *     --application https://app.rayern.com.ng/ \
 *     --objective "Can a user successfully sign up for Rayern?"
 *
 * Safety notes:
 * - Loads the workspace .env via loadEnv (same as the dev server).
 * - Reports only BOOLEAN key presence — never prints values.
 * - Uses the existing concurrency slot semantics (releaseSlotOnFinish: true).
 * - Writes the profiler report to $PROBE_PROFILE_DIR or ./profile-data.
 *   profile-data/ is git-ignored.
 */
import { resolve } from "path";

// ── Env preload (same as server startup) ──────────────────────────────────
const { config: loadDotenv } = await import("dotenv");
loadDotenv({ path: resolve(process.cwd(), "../.env") });
loadDotenv({ path: resolve(process.cwd(), "../.env.local"), override: true });
// Run-scoped override: loadEnv's `override: true` makes .env files win over
// the shell env, so a run-only model override is applied HERE, after dotenv.
if (process.env.DRIVER_AI_MODEL) {
  process.env.AI_MODEL = process.env.DRIVER_AI_MODEL;
}

// ── Profiling must be on before importing modules that read it ────────────
process.env.PROBE_PROFILE = "1";

const { config } = await import("../config/index.js");
const { profiler } = await import("../profiler/index.js");
const { createDurableBackend } = await import("../persistence/index.js");
const { store, useDurableBackend, hydrate, flushAll } = await import("../store/index.js");
const { runInvestigation } = await import("../orchestrator/runner.js");

// ── Durable backend (same as server startup) ────────────────────────────
// Connects MongoDB when MONGODB_URI is set so DB persistence is profiled.
const backend = await createDurableBackend();
useDurableBackend(backend);
await hydrate();
console.log(
  `Persistence: ${backend.kind}${backend.kind === "mongo" ? " (durable; DB ops will be profiled)" : " (memory; no DB ops to profile)"}`
);

// ── CLI args ───────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const REPOSITORY_URL = arg("repository") ?? "";
const APPLICATION_URL = arg("application") ?? "";
const OBJECTIVE = arg("objective") ?? "Can a user successfully sign up for Rayern?";

// ── Safe pre-flight: boolean env/config presence only ─────────────────────
console.log("=== PRE-FLIGHT ===");
console.log(`Node ${process.version}`);
console.log(
  [
    `SOLARI_API_KEY present: ${Boolean(process.env.SOLARI_API_KEY)}`,
    `AI_API_KEY present: ${Boolean(process.env.AI_API_KEY)}`,
    `MONGODB_URI present: ${Boolean(process.env.MONGODB_URI)}`,
    `B2 configured: ${Boolean(process.env.B2_KEY_ID && process.env.B2_APPLICATION_KEY && process.env.B2_BUCKET_NAME)}`,
  ].join(" | ")
);
console.log(
  `Budgets (unchanged): runtime=${config.maxRuntimeMs}ms experiments=${config.maxExperiments} actions=${config.maxBrowserActions} aiCalls=${config.maxAiCalls} aiTokens=${config.maxAiTokens}`
);
console.log(
  `AI: model=${config.aiModel} baseUrl=${config.aiBaseUrl} contextBudget=${process.env.PROBE_AI_CONTEXT_BUDGET ?? "(default)"}`
);
if (!config.solariApiKey || !config.aiApiKey) {
  console.error(
    `FATAL: required keys missing (SOLARI_API_KEY=${Boolean(config.solariApiKey)}, AI_API_KEY=${Boolean(config.aiApiKey)}). ` +
      `Refusing to run a mocked or partial profiling run.`
  );
  process.exit(1);
}

// ── Create the investigation through the store (same path as the API) ────
const investigation = store.createInvestigation({
  repositoryUrl: REPOSITORY_URL,
  applicationUrl: APPLICATION_URL,
  objective: OBJECTIVE,
});
// The API sets an owner; the driver runs single-user, so set a fixed owner.
store.setOwner(investigation.id, "profiler-driver");
console.log(`\n=== INVESTIGATION ${investigation.id} ===`);
console.log(`objective: ${OBJECTIVE}`);
console.log(`repository: ${REPOSITORY_URL}`);
console.log(`application: ${APPLICATION_URL}`);

// ── Run the real pipeline (in-process, awaited) ───────────────────────────
// Progressive snapshots: write a LATEST report every 20s so that even an
// abrupt kill (terminal timeout) leaves complete profiling data on disk.
// Pure observability — no effect on investigation behavior or budgets.
const { mkdirSync, writeFileSync } = await import("node:fs");
const { join } = await import("node:path");
const outDir = process.env.PROBE_PROFILE_DIR ?? join(process.cwd(), "profile-data");
mkdirSync(outDir, { recursive: true });
const snapshotPath = join(outDir, `profile-${investigation.id}-LATEST.json`);
const snapshotTimer = setInterval(() => {
  try {
    writeFileSync(snapshotPath, JSON.stringify(profiler.buildReport(), null, 2));
  } catch {
    /* snapshotting must never break the run */
  }
}, 20_000);
snapshotTimer.unref?.();

const t0 = Date.now();
let failed = false;
try {
  await runInvestigation(investigation.id, { releaseSlotOnFinish: true });
} catch (err) {
  failed = true;
  console.error(`\n[driver] runInvestigation threw:`, err instanceof Error ? err.message : err);
}
const wallMs = Date.now() - t0;
clearInterval(snapshotTimer);

// ── Final state ───────────────────────────────────────────────────────────
const final = store.getInvestigation(investigation.id);
console.log(`\n=== RESULT ===`);
console.log(
  `status=${final?.status} phase=${final?.currentPhase} wallClock=${(wallMs / 1000).toFixed(1)}s`
);
const experiments = store.listExperiments(investigation.id);
console.log(
  `experiments=${experiments.length} completed=${experiments.filter((e) => e.status === "completed").length} failed=${experiments.filter((e) => e.status === "failed").length}`
);
console.log(
  `evidence=${store.listEvidence(investigation.id).length} hypotheses=${store.listHypotheses(investigation.id).length} findings=${store.listFindings(investigation.id).length}`
);
for (const e of experiments) {
  console.log(`  #${e.sequence} [${e.status}] ${e.objective.slice(0, 90)}`);
}

// ── Profiling report: console + files ─────────────────────────────────────
profiler.endPhase(); // close the final phase span (delta timing)
flushAll().catch(() => undefined); // best-effort final checkpoint
console.log(`\n=== PROFILING REPORT (also written to disk) ===`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const base = join(outDir, `profile-${investigation.id}-${stamp}`);
writeFileSync(`${base}.txt`, profiler.formatReport());
writeFileSync(`${base}.json`, JSON.stringify(profiler.buildReport(), null, 2));
console.log(`report: ${base}.txt / ${base}.json`);
console.log(profiler.formatReport());

// Exit 0 even when the investigation failed — the profiler data is the point.
process.exit(0);
