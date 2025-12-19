# Changelog

All notable changes to this project are documented here.

## 0.1.0 - 2025-12-19

First public release.

### CLI

- `summarize` CLI shipped via `@steipete/summarize` (plus optional library exports).
- Inputs: URL, local file path, or remote file URL (PDFs/images/audio/video/text).
- Automatic map-reduce for large inputs.
- Streaming output by default on TTY, with Markdown → ANSI rendering (via `markdansi`).
- Final “Finished in …” line: timing, token usage, cost estimate (when pricing is available), and service counts.
- Flags:
  - `--model <provider/model>` (default `google/gemini-3-flash-preview`)
  - `--length short|medium|long|xl|xxl|<chars>` (guideline; no hard truncation)
  - `--max-output-tokens <count>` (optional hard cap)
  - `--timeout <duration>` (default `2m`)
  - `--stream auto|on|off`, `--render auto|md-live|md|plain`
  - `--extract-only` (URLs only; no summary)
  - `--json` (structured output incl. input config, prompt, extracted content, LLM metadata, and metrics)
  - `--metrics off|on|detailed` (default `on`)
  - `--verbose`

### Sources

- Websites: fetch + extract “article-ish” content + normalization for prompts.
- Firecrawl fallback for blocked/thin sites (`--firecrawl off|auto|always`, via `FIRECRAWL_API_KEY`).
- Markdown extraction for websites in `--extract-only` mode (`--markdown off|auto|llm`).
- YouTube (`--youtube auto|web|apify`):
  - best-effort transcript endpoints
  - optional Apify fallback (requires `APIFY_API_TOKEN`; single actor `faVsWy9VTSNVIhWpR`)
- Files (remote or local): MIME sniffing + best-effort forwarding to the model.
  - text-like inputs are inlined for provider compatibility

### LLM providers

- Direct-provider API keys (no gateway).
- OpenAI-compatible base URL support (`OPENAI_BASE_URL`, `OPENROUTER_API_KEY`).
- Model ids: `openai/...`, `anthropic/...`, `xai/...`, `google/...`.
- Auto-handling of provider/model limitations (e.g. no streaming support → non-streaming call; unsupported media types → friendly error).

### Pricing + limits

- Token/cost estimates and model limits derived from LiteLLM’s model catalog, downloaded + cached under `~/.summarize/cache/`.

### Quality

- CI: lint, tests (coverage), and pack.
- Tooling: Biome (lint/format) + Vitest (tests + coverage gate).
