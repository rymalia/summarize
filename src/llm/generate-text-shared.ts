import type { Context, Message } from "@mariozechner/pi-ai";
import type { Prompt } from "./prompt.js";
import { userTextAndImageMessage } from "./prompt.js";
import type { LlmTokenUsage } from "./types.js";
import { normalizeTokenUsage } from "./usage.js";

export function promptToContext(prompt: Prompt): Context {
  const attachments = prompt.attachments ?? [];
  if (attachments.some((attachment) => attachment.kind === "document")) {
    throw new Error("Internal error: document prompt cannot be converted to context.");
  }
  if (attachments.length === 0) {
    return {
      systemPrompt: prompt.system,
      messages: [{ role: "user", content: prompt.userText, timestamp: Date.now() }],
    };
  }
  if (attachments.length !== 1 || attachments[0]?.kind !== "image") {
    throw new Error("Internal error: only single image attachments are supported for prompts.");
  }
  const attachment = attachments[0];
  const messages: Message[] = [
    userTextAndImageMessage({
      text: prompt.userText,
      imageBytes: attachment.bytes,
      mimeType: attachment.mediaType,
    }),
  ];
  return { systemPrompt: prompt.system, messages };
}

export function isRetryableTimeoutError(error: unknown): boolean {
  if (!error) return false;
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown }).message === "string"
          ? String((error as { message?: unknown }).message)
          : "";
  return /timed out/i.test(message) || /empty summary/i.test(message);
}

export function computeRetryDelayMs(attempt: number): number {
  const base = 500;
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(2000, base * (attempt + 1) + jitter);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withTimeoutFallback<T>({
  promise,
  timeoutMs,
  fallback,
}: {
  promise: Promise<T>;
  timeoutMs: number;
  fallback: T;
}): Promise<T> {
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 30_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), effectiveTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function streamUsageWithTimeout({
  result,
  timeoutMs,
}: {
  result: Promise<{ usage?: unknown }>;
  timeoutMs: number;
}): Promise<LlmTokenUsage | null> {
  const normalized = result.then((msg) => normalizeTokenUsage(msg.usage)).catch(() => null);
  return withTimeoutFallback({
    promise: normalized,
    timeoutMs,
    fallback: null,
  });
}

export function isOpenAiGpt5Model(provider: string, model: string): boolean {
  const normalized = model
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "");
  return (
    (provider === "openai" && /^gpt-5([-.].+)?$/i.test(normalized)) ||
    (provider === "github-copilot" && /^openai\/gpt-5([-.].+)?$/i.test(model))
  );
}

export function resolveEffectiveTemperature({
  provider,
  model,
  temperature,
}: {
  provider: string;
  model: string;
  temperature?: number;
}): number | undefined {
  if (typeof temperature !== "number") return undefined;
  if (isOpenAiGpt5Model(provider, model)) return undefined;
  return temperature;
}

export function shouldRetryGpt5WithoutTokenCap({
  provider,
  model,
  maxOutputTokens,
  error,
}: {
  provider: string;
  model: string;
  maxOutputTokens?: number;
  error: unknown;
}): boolean {
  if (typeof maxOutputTokens !== "number") return false;
  if (!isOpenAiGpt5Model(provider, model)) return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof (error as { message?: unknown })?.message === "string"
          ? String((error as { message?: unknown }).message)
          : "";
  return /empty summary/i.test(message);
}

export function resolveGoogleEmptyResponseFallbackModelId(modelId: string): string | null {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized.startsWith("google/")) return null;
  const raw = normalized.slice("google/".length);
  if (!raw.includes("preview") && !raw.includes("exp")) return null;
  if (raw === "gemini-2.5-flash") return null;
  return "google/gemini-2.5-flash";
}

export function isGoogleEmptySummaryError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof (error as { message?: unknown })?.message === "string"
          ? String((error as { message?: unknown }).message)
          : "";
  return /empty summary/i.test(message);
}
