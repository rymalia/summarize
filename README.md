# summarize 🗜️ — Link → clean text → summary.

Personal URL summarization CLI + a small reusable library.

One npm package: `@steipete/summarize` (CLI + library exports).

Docs (by mode):

- `docs/website.md`
- `docs/youtube.md`
- `docs/firecrawl.md`
- `docs/openai.md`
- `docs/extract-only.md`
- `docs/tweets.md`

## Features

- **URL → clean text**: fetches HTML, extracts the main article-ish content, normalizes it for prompts.
- **YouTube transcripts** (when the URL is a YouTube link):
  - `youtubei` transcript endpoint (best-effort)
  - `captionTracks` (best-effort)
  - Apify transcript actor (optional fallback, requires `APIFY_API_TOKEN`)
  - If transcripts are blocked, we still extract `ytInitialPlayerResponse.videoDetails.shortDescription` so YouTube links summarize meaningfully.
- **Firecrawl fallback for blocked sites**: if direct HTML fetching is blocked or yields too little content, we retry via Firecrawl to get Markdown (requires `FIRECRAWL_API_KEY`).
- **Prompt-only mode**: print the generated prompt and use any model/provider you want.
- **OpenAI mode**: if `OPENAI_API_KEY` is set, calls the Chat Completions API and prints the model output.
- **Structured output**: `--json` emits a single JSON object with extraction diagnostics + the prompt + (optional) summary.
- **Extract-only mode**: `--extract-only` prints the extracted content (no OpenAI call).

## CLI usage

Preferred install (global):

```bash
npm install -g @steipete/summarize
```

Run:

```bash
summarize "https://example.com"
summarize "https://example.com" --prompt
```

One-off (no install):

```bash
npx -y @steipete/summarize "https://example.com"
```

Local dev:

```bash
pnpm install
pnpm build
```

Run without building (direct TS via `tsx`):

```bash
pnpm summarize -- "https://example.com" --prompt
```

Summarize a URL:

```bash
summarize "https://example.com"
```

Print the prompt only:

```bash
summarize "https://example.com" --prompt
```

Change model, length, YouTube mode, and timeout:

```bash
summarize "https://example.com" --length 20k --timeout 30s --model gpt-5.2
summarize "https://www.youtube.com/watch?v=I845O57ZSy4&t=11s" --youtube auto --length 8k
```

Structured JSON output:

```bash
summarize "https://example.com" --json
```

### Flags

- `--youtube auto|web|apify`
  - `auto` (default): try YouTube web endpoints first (`youtubei` / `captionTracks`), then fall back to Apify
  - `web`: only try YouTube web endpoints (no Apify)
  - `apify`: only try Apify (no web endpoints)
- `--firecrawl off|auto|always`
  - `off`: never use Firecrawl
  - `auto` (default): use Firecrawl only as a fallback when HTML fetch/extraction looks blocked or too thin
  - `always`: try Firecrawl first (still falls back to HTML when Firecrawl is unavailable/empty)
- `--length short|medium|long|xl|xxl|<chars>`
  - Presets influence formatting; `<chars>` (e.g. `20k`, `1500`) adds a soft “target length” instruction (no hard truncation).
- `--timeout <duration>`: `30` (seconds), `30s`, `2m`, `5000ms`
- `--model <model>`: default `gpt-5.2` (or `OPENAI_MODEL`)
- `--prompt`: print prompt and exit (never calls OpenAI)
- `--extract-only`: print extracted content and exit (never calls OpenAI)
- `--json`: emit a single JSON object instead of plain text
- `--verbose`: print detailed progress + extraction diagnostics to stderr

## Required services & API keys

### OpenAI (optional, but required for “actual summarization”)

If `OPENAI_API_KEY` is **not** set, the CLI prints the prompt instead of calling an LLM.

- `OPENAI_API_KEY` (required to call OpenAI)
- `OPENAI_MODEL` (optional, default: `gpt-5.2`)

### Apify (optional YouTube fallback)

Used only as a fallback when YouTube transcript endpoints fail and only if the token is present.

- `APIFY_API_TOKEN` (optional)

### Firecrawl (optional website fallback)

Used only as a fallback for non-YouTube URLs when direct HTML fetching/extraction looks blocked or too thin.

- `FIRECRAWL_API_KEY` (optional)

## Library API (for other Node programs)

`@steipete/summarize` exports entry points:

- `@steipete/summarize/content`
  - `createLinkPreviewClient({ fetch?, scrapeWithFirecrawl?, apifyApiToken? })`
  - `client.fetchLinkContent(url, { timeoutMs?, youtubeTranscript?, firecrawl? })`
- `@steipete/summarize/prompts`
  - `buildLinkSummaryPrompt(...)` (`summaryLength` supports presets or `{ maxCharacters }`)
  - `SUMMARY_LENGTH_TO_TOKENS`

## Dev

```bash
pnpm check     # biome + build + tests
pnpm lint:fix  # apply Biome fixes
```
