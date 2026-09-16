/**
 * Read-only DB diagnostic #2 (temporary, investigation support).
 * Prints STRUCTURED facts only — no secrets, no connection strings.
 */
import "../src/loadEnv.js";
import { MongoClient } from "mongodb";

async function main() {
  const client = new MongoClient(process.env.MONGODB_URI || "");
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || "probe");
  const i = await db.collection("investigations").findOne({ id: "inv_1789470483431_1bpnr8" });
  if (!i) {
    console.log("not found");
    return;
  }
  console.log("phaseStats:");
  for (const p of i.phaseStats ?? []) {
    console.log(`  ${p.phase}: ${p.durationMs}ms aiCalls=${p.aiCalls} (${p.startedAt} → ${p.endedAt ?? "open"})`);
  }
  console.log("runtime:", JSON.stringify(i.runtime ?? null));
  const exps = await db.collection("experiments").find({ investigationId: i.id }).sort({ sequence: 1 }).toArray();
  for (const e of exps) {
    console.log(`EXP #${e.sequence} ${e.status} completedAt=${e.completedAt ?? "n/a"}`);
  }
  const evCount = await db.collection("evidence").countDocuments({ investigationId: i.id });
  console.log("evidence count:", evCount);
  await client.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("DB diagnostic failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
