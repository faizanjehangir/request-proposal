import { z } from "zod";

export type ModelConfig = { key: string; model: string };

export function configuredModel(): ModelConfig | null {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.RFP_OPENAI_MODEL;
  return process.env.RFP_EXTRACTION_MODE === "openai" && key && model ? { key, model } : null;
}

export async function requestStructuredJson(
  config: ModelConfig,
  name: string,
  schema: unknown,
  instructions: string,
  content: string,
  request = fetch,
) {
  const response = await request("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
    signal: AbortSignal.timeout(75_000),
    body: JSON.stringify({
      model: config.model,
      store: false,
      instructions,
      input: content,
      text: { format: { type: "json_schema", name, strict: true, schema } },
      max_output_tokens: 20_000,
    }),
  });
  if (!response.ok) throw new Error("AI extraction request failed.");
  const envelope = z.object({
    status: z.literal("completed"),
    output: z.array(z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    })),
  }).parse(await response.json());
  const parts = envelope.output.flatMap((item) => item.content ?? []);
  if (parts.some((item) => item.type === "refusal")) throw new Error("AI extraction declined the request.");
  return JSON.parse(parts.filter((part) => part.type === "output_text").map((part) => part.text).join("")) as unknown;
}
