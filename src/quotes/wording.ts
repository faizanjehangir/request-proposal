import { z } from "zod";
import { configuredModel, requestStructuredJson, type ModelConfig } from "../ai/structured";
import { QuoteError } from "./quote";

export const quoteWordingSchema = z.strictObject({
  opening: z.string().trim().min(1).max(2000),
  closing: z.string().trim().min(1).max(2000),
});

export function quoteAiAvailable(config: ModelConfig | null = configuredModel()) {
  return Boolean(config);
}

export async function draftQuoteWording(config: ModelConfig | null = configuredModel()) {
  if (!config) throw new QuoteError("Configure the OpenAI model and key first.");
  const schema = z.strictObject({ opening: z.string(), closing: z.string() });
  try {
    const result = await requestStructuredJson(config, "air_freight_quote_wording", z.toJSONSchema(schema), [
      "Write a short greeting and closing for a carrier’s air freight proposal.",
      "The app inserts the binding lane terms between the opening and closing.",
      "Mention no prices, dates, service promises, or operational details.",
      "Ask the shipper to confirm acceptance of the offered lanes in this version by replying.",
    ].join(" "), "Use a direct and professional tone.");
    return quoteWordingSchema.parse(result);
  } catch {
    throw new QuoteError("AI did not return usable wording. Edit the opening and closing or try again.");
  }
}
