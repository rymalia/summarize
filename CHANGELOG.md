# Changelog

All notable changes to this project are documented here.

## 0.1.0 - 2025-12-17

- CLI `summarize` (global install) + reusable library exports in `@steipete/summarize`.
- Website extraction: fetch HTML → extract “article-ish” content → normalize for prompts.
- Firecrawl fallback for blocked/thin sites (`--firecrawl off|auto|always`, requires `FIRECRAWL_API_KEY`).
- YouTube extraction (`--youtube auto|web|apify`):
  - `youtubei` transcript endpoint (best-effort)
  - `captionTracks` timedtext extraction (best-effort)
  - optional Apify fallback (requires `APIFY_API_TOKEN`)
  - fallback to `ytInitialPlayerResponse.videoDetails.shortDescription` when transcripts are unavailable
- OpenAI summarization (Chat Completions API) with default model `gpt-5.2` (`OPENAI_API_KEY`, optional `OPENAI_MODEL`).
- `--extract-only` (no LLM call), `--prompt` (prompt-only), `--json` (structured output), `--timeout`, `--verbose`.
- Tests + coverage gate (>= 75%) via Vitest + v8 coverage; lint/format via Biome.

