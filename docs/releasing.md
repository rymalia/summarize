---
summary: 'Release checklist + Homebrew tap update.'
---

# Releasing

## Goals

- Ship npm packages (core first, then CLI).
- Tag + GitHub release.
- Update Homebrew tap so `brew install steipete/tap/summarize` matches latest tag.

## Checklist

1. `scripts/release.sh all` (gates → build → verify → publish → smoke → tag → tap).
2. Create GitHub release for the new tag (match version, attach notes/assets as needed).
3. If you didn’t run `tap` in the script, update the Homebrew tap formula for `summarize`:
   - Bump version to the new tag.
   - Update tarball URL + SHA256 for the new release.
4. Verify Homebrew install reflects the new version:
   - `brew install steipete/tap/summarize`
   - `summarize --version` matches tag.
   - Run a feature added in the release (e.g. `summarize daemon install` for v0.8.2).
5. If anything fails, fix and re-cut the release (no partials).

## Common failure

- NPM/GitHub release updated, tap not updated → users stuck on old version.
  Fix: always do step 3–4 before announcing.
