export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  solariApiKey: process.env.SOLARI_API_KEY || "",
  aiApiKey: process.env.AI_API_KEY || "",
  aiBaseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
  aiModel: process.env.AI_MODEL || "gpt-4o",
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",
} as const;

export function validateConfig(): void {
  if (!config.solariApiKey) {
    throw new Error("SOLARI_API_KEY is required");
  }
}
