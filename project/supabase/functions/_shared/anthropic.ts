/**
 * Shared Anthropic client for the edge functions.
 *
 * Exists because a single 529 "overloaded" — a transient, explicitly retryable condition —
 * used to fail a pipeline run outright, discarding a script and a voiceover that had
 * already been paid for. Overloads, rate limits and 5xx are worth waiting out; a 400 or a
 * 401 is not, and retrying those just wastes time.
 */

const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);

/**
 * Server-side refusal fallbacks exist only on these models. Sending `fallbacks` to
 * anything else is a hard 400, so the parameter is added per model rather than always —
 * deriving it here means a caller cannot get it wrong by forgetting to opt out.
 */
const SUPPORTS_FALLBACKS = new Set(["claude-opus-5", "claude-fable-5", "claude-mythos-5"]);

export interface AnthropicCallOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  system?: string;
  prompt: string;
  /** `output_config` contents — effort, structured-output format, and so on. */
  outputConfig?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface AnthropicResult {
  text?: string;
  error?: string;
  /** Set when the model declined rather than failed. */
  refused?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callAnthropic(options: AnthropicCallOptions): Promise<AnthropicResult> {
  const {
    apiKey,
    model = "claude-opus-5",
    maxTokens = 8000,
    system,
    prompt,
    outputConfig,
    maxAttempts = 4,
  } = options;

  let lastError = "";
  const withFallbacks = SUPPORTS_FALLBACKS.has(model);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          ...(withFallbacks ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          ...(outputConfig ? { output_config: outputConfig } : {}),
          ...(withFallbacks ? { fallbacks: "default" } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch (err) {
      // Network-level failure: worth another go.
      lastError = `Network error: ${err instanceof Error ? err.message : String(err)}`;
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return { error: lastError };
    }

    if (response.ok) {
      const data = await response.json();

      if (data.stop_reason === "refusal") {
        return { refused: true, error: "Claude declined this request." };
      }

      const text = data.content?.find((b: { type: string }) => b.type === "text")?.text;
      if (!text) return { error: "Claude returned no text content." };
      return { text };
    }

    const errText = await response.text();
    lastError = `Anthropic request failed: ${response.status} — ${errText.slice(0, 400)}`;

    if (!RETRYABLE.has(response.status) || attempt === maxAttempts) {
      return { error: lastError };
    }

    // Honour Retry-After when the API sends one, otherwise back off exponentially.
    const retryAfter = Number(response.headers.get("retry-after"));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt));
  }

  return { error: lastError || "Anthropic request failed" };
}

/** 1s, 2s, 4s … with jitter, so parallel callers don't retry in lockstep. */
function backoffMs(attempt: number): number {
  return Math.round(2 ** (attempt - 1) * 1000 * (0.75 + Math.random() * 0.5));
}
