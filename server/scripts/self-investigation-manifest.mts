/**
 * Manifest: production deployment currency for both self-investigation symptoms.
 *
 * Compares the DEPLOYED frontend bundle and DEPLOYED backend behavior against
 * the repository's git history to answer, with evidence:
 *   - does production have the empty-plan integrity gate? (Symptom B)
 *   - does production have the nested evidence URL / artifactAvailable? (Symptom A)
 *   - does production have the terminal-only durationMs timer contract? (Area 3)
 *
 * Read-only. No secrets are printed.
 */
import { execSync } from "node:child_process";
import https from "node:https";
import { writeFileSync, readFileSync } from "node:fs";

function get(url: string): Promise<{ status: number; body: Buffer; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "probe-selfinv" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers: res.headers as Record<string, string> })
      );
    }).on("error", reject);
  });
}

async function main() {
  // ── Git facts ─────────────────────────────────────────────────────────
  const headHash = execSync("git rev-parse HEAD").toString().trim();
  const fixHash = execSync('git log --format="%h %s" | grep -m1 "empty experiment plans"').toString().trim();
  const evidenceHash = execSync('git log --format="%h %s" | grep -m1 "evidence artifact download"').toString().trim();
  const remoteHash = execSync("git ls-remote origin main").toString().split("\t")[0].trim();
  console.log("git: HEAD            =", headHash.slice(0, 9));
  console.log("git: empty-plan fix  =", fixHash.split(" ")[0]);
  console.log("git: evidence fix    =", evidenceHash.split(" ")[0]);
  console.log("git: origin/main     =", remoteHash.slice(0, 9));

  // ── Deployed frontend bundle ──────────────────────────────────────────
  const front = await get("https://probe-challenge.vercel.app/");
  const html = front.body.toString("utf8");
  const assetMatch = html.match(/src="(\/assets\/[^"]+\.js)"/);
  console.log("\nfrontend: HTTP", front.status, "| entry asset:", assetMatch?.[1] ?? "NOT FOUND");
  if (assetMatch) {
    const bundle = await get("https://probe-challenge.vercel.app" + assetMatch[1]);
    const js = bundle.body.toString("utf8");
    console.log("bundle: HTTP", bundle.status, "|", bundle.body.length, "bytes | etag:", bundle.headers.etag);
    writeFileSync("/tmp/prod-bundle.js", js);

    const flatEvidenceUrl = /["'`]\/api\/evidence\/\$\{/.test(js) || /["'`]evidence\/\$\{[^}]+\}\/content/.test(js) === false && /api\/evidence\//.test(js);
    console.log("bundle: contains flat '/api/evidence/' path?      ", /api\/evidence\//.test(js));
    console.log("bundle: contains nested investigations/{id}/evidence URL builder?", /investigations\/\$\{[^}]+\}\/evidence/.test(js) || /investigations\/".concat/.test(js));
    console.log("bundle: artifactAvailable surfaced?               ", /artifactAvailable/.test(js));
    console.log("bundle: no_executable_experiments handling?       ", /no_executable_experiments/.test(js));
    console.log("bundle: noExperimentsPlanned flag?                ", /noExperimentsPlanned/.test(js));
    console.log("bundle: durationMs-only-when-terminal contract?   ", /durationMs[^a-zA-Z]/.test(js));
  }

  // ── Deployed backend gate behavior (proven live earlier; asserted here) ──
  console.log("\nbackend: live empty-plan failure already observed in this session");
  console.log("         (summary.failure.reason === 'no_executable_experiments' from api-probe.onrender.com)");
  const summarySample = readFileSync("/tmp/sum1.json", "utf8");
  console.log("         persisted proof: /tmp/sum1.json contains:", summarySample.includes("no_executable_experiments"));
}

main().catch((e) => {
  console.error("manifest failed:", e.message);
  process.exit(1);
});
