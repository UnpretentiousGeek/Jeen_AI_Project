import OpenAI from "openai";

/**
 * The one OpenAI client configuration for every model call the app makes.
 *
 * Fact extraction, policy assessment and the case assistant share the account's tokens-per-minute
 * limit, so a burst from one caller can rate-limit another. A rate-limited request therefore waits
 * and retries (the SDK honours OpenAI's `retry-after`, else backs off exponentially) instead of
 * failing the step that made it. The timeout covers one attempt, not the retries.
 */
export function createModelClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, timeout: 120_000, maxRetries: 6 });
}
