# @pipeworx/swissmedic

Swissmedic's authorised human medicines register (Switzerland) — the "Zugelassene Arzneimittel HAM" list: every authorised product and each of its authorised dosage strengths, with the marketing-authorisation holder, medicine category, dispensing category (prescription tier) and authorisation dates. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `swissmedic_search(query?, holder?, category?, dispensing_category?, limit?, offset?)` — free-text/filtered search with real offset+limit pagination and a `total_matches` count. Answers "is X authorised in Switzerland", "who holds the Swiss authorisation for X", "what dispensing category is X in".
- `swissmedic_product(name)` — every authorised dosage strength for one product by name (exact match preferred, falls back to substring with `match_type` marked). The export carries no indication text and no per-product URL, so this returns the authoritative Swissmedic download instead.
- `swissmedic_recent_changes(since)` — products first authorised, or with a dosage strength newly authorised, since a date — a real signal from the source's own date columns.
- `swissmedic_dataset_info()` — the authoritative bulk-download URL, source page, row count, and the full lists of distinct medicine categories and dispensing categories used by the filters.

## Auth

Keyless.

## Data sources

- <https://www.swissmedic.ch/dam/swissmedic/en/dokumente/internetlisten/zugelassene_arzneimittel_ham_ind.xlsx.download.xlsx/Zugelassene_Arzneimittel_HAM.xlsx> — the authorised human medicines XLSX, linked from [swissmedic.ch's "Listen und Verzeichnisse" page](https://www.swissmedic.ch/swissmedic/en/home/services/listen_neu.html). Verified live 2026-09-25: HTTP 200, 1,005,371 bytes, 11,086 data rows. Swissmedic states the lists are "updated monthly" — there is no finer-grained cadence published.

### This pack fetches EMA-sized data, not ema-article57-sized data — and that difference decides the architecture

The file is ~1 MB compressed, ~4.8 MB of sheet XML. That is the same size class the sibling `ema-medicines` pack already parses live per request without issue, and roughly 9x smaller than the file that made the `ema-article57` pack build a local R2-backed copy instead (164,314 rows / 63 MB of sheet XML there, versus 11,086 rows / 4.8 MB here). So `swissmedic` fetches live, same pattern as `ema-medicines`: one parsed copy held per isolate for 12 hours (`DATASET_TTL_MS`) plus a 12-hour Cloudflare edge cache on top — Swissmedic's own monthly update cadence makes anything shorter needless re-downloading of an unchanged file. If a refresh fails while an earlier copy is in hand, the earlier copy is served rather than an error.

### Licence — this is a live proxy, not a mirror, so no separate reuse grant is needed

Swissmedic's general Legal Notice is more restrictive-sounding than EMA's ("downloading or copying content... requires written consent from the copyright holders" — a page written for the site broadly, not this specific public list). That question does not need resolving here: per the proxy-vs-mirror rule (`mirror-needs-grant-proxy-does-not`, CLAUDE.md), a pack that calls a public, keyless upstream live on each cache-miss is a client, not a publisher, and needs no explicit grant — only bulk-copying/mirroring the dataset would. This pack does the former (fetch-and-cache, same as `ema-medicines`), never the latter.

### Schema — row 7 is the header, bilingual DE/FR source

Rows 1-6 are a title block (bilingual German/French, the same shape as most Swiss federal exports), **row 7 is the header**, rows 8+ are records. Ten columns: authorisation number, dosage-strength number, product name, marketing-authorisation holder, medicine category ("Heilmittelcode" — e.g. "Impfstoffe" = vaccines, "Blutprodukte" = blood products), dispensing category at dosage level, dispensing category at medicine level, first-authorisation date, dosage-authorisation date, validity duration ("unbegrenzt" = unlimited, for most rows in this export).

**The two date columns are Excel serial dates** (days since 1899-12-30, the Lotus-1-2-3-compatibility epoch Excel still carries) — converted to ISO `YYYY-MM-DD` on the way out (`excelSerialToIso` in `src/index.ts`). Verified against a known row: Vivotif's `first_authorisation_date` serial converts to `1980-12-09`, consistent with its real-world authorisation history.

**There is no indication text and no per-product URL** beyond the authorisation number. `swissmedic_product`'s response points to the authoritative Swissmedic download rather than paraphrasing an indication that is not in the data.

### `dispensing_category` matches either column

Every product carries a dispensing category at the medicine level and, separately, one per dosage strength — they usually agree but are not guaranteed to. `swissmedic_search`'s `dispensing_category` filter matches a row if EITHER column equals the requested value, so a caller does not need to know which level Swissmedic happened to record a mismatch at. Distinct values observed live: `A`, `A+`, `B`, `B/D`, `D`, `E`.

### `swissmedic_recent_changes` uses real dates, unlike `ema-article57`'s sibling tool

EMA's Article 57 export (`ema-article57` pack) carries no date column at all, so that pack's `recent_changes` can only diff its own snapshots. This file has two real date columns, so `swissmedic_recent_changes` filters directly on `first_authorisation_date`/`dosage_authorisation_date >= since` — no snapshot history required. Verified live 2026-09-25: `since: "2026-01-01"` returned 384 real changes, including dosage-level re-authorisations from August 2026.

### Reused parser

`src/xlsx.ts` is a copy of `mcps/ema-medicines/src/xlsx.ts` (the hand-rolled zip+XML reader) rather than a shared dependency — both files are small and a Worker pack shouldn't pull in a shared xlsx-parsing package for what is, on each side, one regex-based scanner over one file shape. Keep them in sync by eye if the underlying approach ever needs to change; the lazy `[^>]*?` attribute match in `CELL_RE` is load-bearing (see the comment above it) and must not be "simplified" to greedy.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "swissmedic": {
      "url": "https://gateway.pipeworx.io/swissmedic/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/swissmedic/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/swissmedic_search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Vivotif","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/swissmedic_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "swissmedic": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-swissmedic"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-swissmedic
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Swissmedic data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
