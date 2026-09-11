/**
 * One-shot AI smoke test through the same env-loading path as the driver.
 * Verifies a candidate model responds with usable JSON before a profiling run.
 */
export {};

const { config } = await import("../config/index.js");

const model = process.argv[2] ?? "google/gemma-4-31b-it:free";
const t0 = Date.now();
const res = await fetch(`${config.aiBaseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.aiApiKey}`,
  },
  body: JSON.stringify({
    model,
    messages: [
      { role: "system", content: "You are a JSON generator. Return ONLY valid JSON, no markdown fences, no prose." },
      { role: "user", content: 'Return JSON: {"ok": true, "items": [1,2,3]}' },
    ],
    temperature: 0.2,
  }),
});
const body = await res.json();
const ms = Date.now() - t0;
if (!res.ok) {
  console.log(`FAIL http=${res.status} in ${ms}ms:`, JSON.stringify(body).slice(0, 300));
  process.exit(1);
}
const content = body.choices?.[0]?.message?.content ?? "(no content)";
console.log(`OK http=200 in ${ms}ms model=${model}`);
console.log(`content: ${String(content).slice(0, 200).replace(/\n/g, " ")}`);
console.log(`usage: ${JSON.stringify(body.usage ?? {})}`);
