# Guangdong Unicom APTV Playlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `gd-unicom.m3u` retain all same-channel lines for APTV and add `gd-unicom-simple.m3u` as the single-line compatibility variant.

**Architecture:** Reuse the existing Guangdong Unicom parser. Swap the render targets so the full parsed entry list becomes the primary playlist and the deduplicated list becomes the compatibility playlist. Update workflow validation and generated-file commits accordingly.

**Tech Stack:** Node.js 22, GitHub Actions, M3U/HLS.

## Global Constraints
- Do not probe stream reachability from GitHub Actions.
- Preserve existing Guangdong Telecom behavior.
- Keep upstream ordering for alternate lines.

---

### Task 1: Change Guangdong Unicom outputs

**Files:**
- Modify: `scripts/generate-unicom.mjs`

- [ ] Render all parsed entries to `m3u/gd-unicom.m3u`.
- [ ] Render first-entry-per-channel to `m3u/gd-unicom-simple.m3u`.
- [ ] Keep report counts for unique channels and alternate entries.

### Task 2: Update CI validation and commit list

**Files:**
- Modify: `.github/workflows/update.yml`

- [ ] Validate both new primary and simple playlists.
- [ ] Commit `gd-unicom-simple.m3u` instead of the old `gd-unicom-all.m3u` output.
- [ ] Preserve all existing Telecom checks.

### Task 3: Verify generated outputs

- [ ] Confirm the workflow succeeds.
- [ ] Confirm `gd-unicom.m3u` contains repeated `#EXTINF` records for channels such as CCTV13 when upstream provides multiple URLs.
- [ ] Confirm `gd-unicom-simple.m3u` contains one record for the same channel.
