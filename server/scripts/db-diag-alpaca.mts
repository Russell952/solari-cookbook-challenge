/**
 * Read-only DB diagnostic (temporary, investigation support).
 * Loads env the same way the server does and prints STRUCTURED facts only —
 * no secrets, no connection strings, no credential values.
 */
import "../src/loadEnv.js";
import { MongoClient } from "mongodb";

async function main() {
  const uri = process.env.MONGODB_URI || "";
  if (!uri) {
    console.log("no MONGODB_URI configured");
    process.exit(0);
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || "probe");
  const invs = await db
    .collection("investigations")
    .find({ applicationUrl: { $regex: "alpaca" } })
    .toArray();
  console.log("alpaca investigations:", invs.length);
  for (const i of invs) {
    console.log("---", i.id ?? String(i._id), "| status:", i.status, "| phase:", i.currentPhase);
    console.log("  failure:", JSON.stringify(i.failure ?? null));
    const exps = await db.collection("experiments").find({ investigationId: i.id }).toArray();
    console.log("  experiments:", exps.length, exps.map((e) => `#${e.sequence}:${e.status}`).join(" "));
    const hyps = await db.collection("hypotheses").find({ investigationId: i.id }).toArray();
    console.log("  hypotheses:", hyps.length, hyps.map((h) => h.status).join(","));
    const reports = await db.collection("reports").find({ investigationId: i.id }).toArray();
    console.log("  reports:", reports.length, reports.map((r) => String(r.summary || "").slice(0, 80)));
    const evs = await db.collection("evidence").find({ investigationId: i.id }).toArray();
    console.log("  evidence:", evs.length);
    const self = await db.collection("investigations").findOne({ id: i.id }, { projection: { phaseStats: 1, budgetUsage: 1 } });
    console.log("  phaseStats:", JSON.stringify(self?.phaseStats ?? null).slice(0, 400));
    console.log("  budgetUsage:", JSON.stringify(self?.budgetUsage ?? null).slice(0, 400));
  }
  await client.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("DB diagnostic failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
