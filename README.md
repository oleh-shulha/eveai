# EVE AI Agent

> **This repository is an independent fork of [garshany/eveai](https://github.com/garshany/eveai).**
> It is maintained separately and is not affiliated with, endorsed by, or supported by the upstream
> project or its operator. Open issues and pull requests here, not upstream. Upstream runs its own
> public deployment at [eveonline-ai.ru/app](https://eveonline-ai.ru/app); this fork ships no hosted
> service — you self-host it.

## Differences from upstream

What this fork changes on top of `garshany/eveai`:

- **The endpoint is configuration, not code (`OPENAI_BASE_URL`).** Upstream hard-codes two vendor
  endpoints and ignores any base URL. Here `OPENAI_BASE_URL` is required and is the only thing that
  decides where requests go, so the agent runs against any OpenAI Responses-compatible API — an
  OpenRouter route (Claude, Gemini, Llama, …), a corporate gateway, or a local proxy. It is validated
  at startup only for what would otherwise break or leak: absolute http(s) API root, no embedded
  credentials. Which host you trust is your call, not the app's.
- **`OPENAI_PROFILE` replaces `OPENAI_PROVIDER`.** The old variable named a vendor and carried its
  address; the new one declares only what the endpoint supports. `openai` uses the full official
  contract (hosted tool search and Programmatic Tool Calling, `truncation`, encrypted reasoning
  replay, server-side response state). `compatible` assumes only the core of the Responses API and
  switches to the application-owned substitutes: client tool search, the bounded local parallel
  batch, read subagents, and stateless continuation.
- **Static data refreshed from the browser.** Settings gains an operator-only SDE panel: one button asks CCP
  whether a newer archive exists (headers only, no download), the other downloads it, reloads the static tables
  and rebuilds the Perimeter map graph as a single job with visible progress. Access is the
  `WEB_ADMIN_CHARACTER_IDS` allowlist of EVE character ids; empty means nobody. Upstream can only do this on the
  host with `npm run setup` plus a restart. The snapshot's build number now comes from the archive's own ETag
  instead of the load date, so a same-day reload no longer leaves the map built from the previous universe.
- **A private instance behind one password (`PRIVATE_PASSWORD`).** A public hostname no longer means a public
  app: every browser API call answers `unlock_required` until the visitor enters the password once, and the unlock
  is a signed HttpOnly cookie the browser keeps. The EVE SSO flow, `/health` and the app shell stay open, so a
  login started from Telegram or the CLI still completes in a fresh browser. Wrong attempts are budgeted per
  address, and changing the password locks every browser out again.
- **A character allowlist for the browser app (`WEB_ALLOWED_CHARACTER_IDS`).** Password aside, the app can be
  limited to named EVE characters: anyone else gets one honest screen instead of a working app, and EVE SSO
  refuses to attach an unlisted character to a browser login in the first place — before any token is stored.
  The session bootstrap and the SSO start stay open so an allowed pilot can link in.
- **Internet access for the agent (Firecrawl).** Set `FIRECRAWL_URL` and `FIRECRAWL_API_KEY` and the agent gains
  open-web search plus `fetch_web_page`, which reads one public page as Markdown — patch notes, dev blogs, forum
  threads, wikis, third-party tools — and cites it. Upstream can only search snippets through Tavily and never
  reads a page. A settings panel shows the configured endpoint and switches the access off at runtime without a
  restart; the switch is stored. Fetched text is treated as untrusted data, loopback and private addresses are
  refused before egress, and pages are bounded per turn and truncated to a character budget.
- **Market snapshot controls in the same panel.** Snapshot age, row count, stale and errored region counts, the
  last sweep error, and whether a sweep is running right now — plus a *Load now* button that treats every region
  as due while still respecting ESI's five-minute cache window.
- **`OPENAI_PROVIDER_NAME` names the recipient of user data.** The browser consent screen and the
  startup banner show it; unset, it falls back to the host of `OPENAI_BASE_URL` instead of a vendor
  label that may no longer be true. See [Required Environment](#required-environment).

Everything below is inherited from upstream and describes the project itself.

> **Landing-page source:** [`index.html`](./index.html). GitHub Pages is optional and is not currently a deployed product endpoint.

Self-hosted, chat-first AI assistant for EVE Online. Run it through the browser, Telegram, Discord DMs, or the terminal CLI; it combines local EVE SDE data, live ESI data, killboard intelligence, route planning, and a Responses-compatible model loop with tool calling.

The optional same-origin browser app uses the same backend agent and SQLite state. The project does not require Redis, Postgres, queues, workers, or webhooks.

## v4.1 public release

v4 turns EVE AI Agent into a durable multi-user agent service while preserving
the self-hosted single-process and SQLite architecture. v4.1 grows the browser
workspace into a full pilot hub:

- **Market workspace.** Regional order books from a local snapshot sweep, full
  SDE item cards, market history and alerts, and a natural-language AI item
  picker running a tightly budgeted tool loop on the shared admission/quota layer.
- **Live pilot profile.** Location-grouped assets appraised against the local
  order book, orders, wallet, clones, skills, and granted scopes — every block
  with its own freshness marker.
- **Per-user model settings.** Model (Sol/Terra/Luna), reasoning effort, and
  verbosity per user, applied across browser, Telegram, Discord, and CLI, with
  guest gating and honest usage accounting for subagents and compaction.
- **Community integrations.** Bounded tools with schemas verified against live
  responses: EVE Ref industry cost, item appraisal (local book with optional
  Janice), zKillboard pilot intel, and MutaMarket abyssal prices.
- **Transparency.** A public page shows real model tariffs and per-request
  token usage; re-login no longer loses linked characters, sessions, or chats.

The v4.0 foundation underneath:

- A root agent builds and maintains a dependency-aware plan, tracks required
  outcomes, discovers deferred tools, and keeps working until the requested
  result is completed or explicitly reported unavailable.
- Independent public research can be delegated to bounded read subagents. They
  receive only allowlisted public tool schemas and public numeric IDs—never chat
  history, private ESI data, credentials, or write capabilities.
- Direct tool calls, parallel public reads, local parallel batches, and optional
  Programmatic Tool Calling share validation, admission, deadline, cancellation,
  identity, and output-size boundaries.
- The browser chat now uses a durable asynchronous SQLite queue with idempotent
  submission, authenticated SSE plus polling recovery, explicit cancellation,
  per-user lane serialization, and bounded global concurrency for public traffic.
- Browser users can keep several EVE characters attached to one account, choose
  the active character, and grant only the ESI scopes they want. Consent is
  versioned and presented in Russian and English.
- The official OpenAI contract remains the reference path. The `compatible`
  profile supports the same application-owned local tools and defaults to the
  bounded public read-subagent path on any OpenAI-compatible endpoint.
- Public deployment controls now include Turnstile verification, trusted-proxy
  CIDRs, HTTPS/hostname validation, request and compute-unit limits, durable
  restart recovery, queue health, and sanitized terminal errors.

The release evaluation covers complex multi-stage planning, tool discovery,
parallel research, private/public data separation, cancellation, identity
changes, terminal completeness, and a 100-user coordinator load scenario.

For a public SSO callback, use HTTPS, set the callback URL exactly in the EVE Developer Portal, generate a strong `AUTH_SECRET_KEY`, give ESI a reachable operator contact, and keep `.env` plus `data/` on the host only. The detailed production checklist is in [docs/deployment.md](./docs/deployment.md).

## Capabilities

- **Perimeter live map:** an ego-centric graph of the systems around your pilot where the ring index *is* the jump distance, with live kill activity, explainable danger scoring, gate-camp detection, wormhole shortcuts, risk-weighted routing, and an agent chat that warns you unprompted — pursuit, camps on the next hop, and hulls that out-class yours.
- Optional internet access: open-web search and single-page reading through Firecrawl, with an operator kill switch.
- Optional access control for the browser app: a shared unlock password and an EVE character allowlist, with the SSO flow left reachable.
- Natural-language Telegram and Discord assistant for EVE Online questions and workflows.
- Same-origin browser chat with anonymous sessions, conversation history, optional EVE SSO, and the same guarded agent/tool loop.
- Browser market workspace: regional order books, SDE item cards, market history and alerts, and a natural-language AI item search.
- Live pilot profile with local-book asset appraisal, orders, wallet, clones, skills, and per-block freshness markers.
- Per-user model, reasoning-effort, and verbosity preferences honored across browser, Telegram, Discord, and CLI.
- Community data integrations: EVE Ref industry cost, local/Janice item appraisal, zKillboard pilot intel, and MutaMarket abyssal prices.
- Durable multi-user browser execution with idempotent `202` acceptance, SSE/poll recovery, cancellation, per-user lanes, and bounded shared capacity.
- Dependency-aware root-agent planning, effective tool discovery, goal-ledger completion checks, parallel public reads, and sandboxed read subagents.
- EVE SSO linking for private character data, with scope-aware capability gating.
- Local SDE SQLite lookups for static game data such as systems, items, dogma, blueprints, and routes.
- Live ESI access for character, corporation, market, location, mail, skills, industry, assets, and related data when scopes are granted.
- Route planning with live danger analysis, killmail context, gate-camp signals, Thera/Turnur shortcut support, and monitor mode.
- D-scan, fleet, local, OSINT, current EVE-KILL REST/feed intelligence, EVE-Scout, and intel notes.
- Heartbeat notifications (mail, skills, wallet, industry, kills, and more) delivered to the chat where you talk to the bot.

## Architecture

```text
Telegram private chat ──> grammY long polling bot ─┐
Discord DM ───────────────> discord.js gateway bot ├─> shared agent runtime
Browser /app ─────────────> Fastify session API ───┘        │
                                                            v
                                      durable request coordinator + root agent
                                                             │
                           plan / goal ledger / tool registry / read subagents
                                                             │
                                                             v
                          Responses endpoint from OPENAI_BASE_URL
                                                             │
                                                             v
                                ESI / local SDE / EVE-KILL REST+feed ──> SQLite

Browser ──> Fastify ──> HttpOnly session + EVE SSO + /health ──> same SQLite state
```

Hard constraints:

- Single-process Node.js app.
- SQLite only.
- Telegram long polling only; no webhooks. Discord standard gateway connection.
- The browser app is explicit opt-in (`WEB_CHAT_ENABLED=true`), same-origin, and never receives provider or ESI credentials.
- Static game data comes from the installed local SDE SQLite snapshot; its build/load metadata describes that snapshot and is not a claim of current freshness. Live authoritative character/market data comes from ESI; public kill discovery comes from EVE-KILL.
- Private ESI access is isolated per user/chat and gated by `get_eve_capabilities`.
- The model must not see tokens, refresh flow, pagination internals, retry logic, or secrets.

## Requirements

- Node.js 20.19+.
- npm.
- At least one bot token:
  - Telegram bot token from [@BotFather](https://t.me/BotFather), and/or
  - Discord bot token from <https://discord.com/developers/applications> (no privileged intents needed; the bot works in DMs).
- EVE Developer application from <https://developers.eveonline.com/>.
- An API key for the endpoint in `OPENAI_BASE_URL` (the official OpenAI API or any OpenAI-compatible Responses gateway).

## Quick Start

```bash
git clone <your-public-fork-url> eveai
cd eveai
cp .env.example .env       # fill in the tokens
npm ci
npm run setup              # download + load EVE static data (SDE)
npm run dev
```

Then open a private chat with your Telegram bot, DM your Discord bot, or set
`WEB_CHAT_ENABLED=true` and open `http://localhost:3000/app`.

### Docker

```bash
docker build -t eveai .
docker run -d --name eveai --env-file .env -p 3000:3000 -v eveai-data:/app/data eveai

# First run only: download and load the EVE static data into the volume.
docker exec eveai npm run setup:built
docker restart eveai
```

The image compiles the server and the browser app itself, runs as a non-root
user, and carries `unzip`, so both `npm run setup:built` and the in-app SDE
refresh work inside the container. Everything mutable — SQLite database, the SDE
snapshot, caches — lives in `/app/data`; mount a volume over it. The image sets
`HOST=0.0.0.0` (a loopback bind would be unreachable from outside the
container), so do not override `HOST` in your `.env`. See
[docs/deployment.md](./docs/deployment.md#docker) for reverse proxy, updates,
and bind-mount ownership.

For local EVE SSO callbacks, set the callback URL in the EVE Developer Portal to:

```text
http://localhost:3000/auth/eve/callback
```

## Required Environment

Minimum local `.env` values (enable at least one bot or the browser chat):

```env
TELEGRAM_BOT_TOKEN=...        # and/or DISCORD_BOT_TOKEN
DISCORD_BOT_TOKEN=...
WEB_CHAT_ENABLED=true
WEB_BASE_URL=http://localhost:3000
OPENAI_PROFILE=openai         # openai | compatible
OPENAI_BASE_URL=https://api.openai.com/v1   # required; any OpenAI-compatible Responses root
# OPENAI_PROVIDER_NAME=OpenRouter           # optional label shown to users; default = the host
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-sol
OPENAI_RESPONSE_STATE_MODE=stateless
OPENAI_STORE_RESPONSES=false
OPENAI_PROGRAMMATIC_TOOL_CALLING=false
OPENAI_REASONING_EFFORT=auto
OPENAI_REASONING_MODE=standard
OPENAI_TEXT_VERBOSITY=low
OPENAI_RESPONSES_TIMEOUT_MS=300000
OPENAI_RESPONSE_LANGUAGE=Russian
EVE_CLIENT_ID=...
EVE_CLIENT_SECRET=...
AUTH_SECRET_KEY=replace-with-random-secret
EVE_CALLBACK_URL=http://localhost:3000/auth/eve/callback
DEFAULT_MARKET_REGION_ID=10000002
DEFAULT_MARKET_REGION_NAME="The Forge"
ESI_USER_AGENT=EVEAI/4.0 (+https://github.com/your-org/eveai; contact=you@example.com)
EVE_KILL_USER_AGENT=EVEAI/4.0 (+https://github.com/your-org/eveai; contact=you@example.com)
```

Generate `AUTH_SECRET_KEY` with:

```bash
openssl rand -base64 32
```

Optional, and specific to this fork — all four default to off:

```env
# Close a public deployment: one shared password in front of the browser API.
PRIVATE_PASSWORD=                     # >= 8 chars, needs AUTH_SECRET_KEY
PRIVATE_UNLOCK_TTL_HOURS=720          # how long one unlock lasts
# Only these EVE characters may use the browser app (comma-separated ids).
WEB_ALLOWED_CHARACTER_IDS=
# These characters additionally see the operator panels (SDE, market, web access).
WEB_ADMIN_CHARACTER_IDS=
# Internet access for the agent: open-web search plus reading one page.
FIRECRAWL_URL=                        # service root, no /v1 or /v2 suffix
FIRECRAWL_API_KEY=
```

Access control:

- `PRIVATE_PASSWORD` locks the browser API: every `/api/web/*` call answers `unlock_required` until the visitor enters the password once, and the unlock is a signed HttpOnly cookie. `/health`, the app shell and the whole EVE SSO flow stay reachable, so a login started in Telegram or the CLI still completes. Rotating the password locks every browser out again.
- `WEB_ALLOWED_CHARACTER_IDS` restricts the app to named characters: anyone else gets one screen saying so, and EVE SSO refuses to attach an unlisted character to a browser login before any token is stored. Chat lanes keep their own allowlists (`ALLOWED_TELEGRAM_USER_ID`, `ALLOWED_DISCORD_USER_ID`).
- `WEB_ADMIN_CHARACTER_IDS` is a separate, narrower list for the operator panels. Empty means nobody. Put your own character in both lists when you use both.

Both lists take numeric EVE character ids, never names: EVE SSO identifies a
character as `CHARACTER:EVE:<id>`, and that id is the key every link in the
database hangs on. Resolve a name with the public ESI endpoint:

```bash
curl -s -X POST 'https://esi.evetech.net/latest/universe/ids/?datasource=tranquility' -H 'Content-Type: application/json' -d '["Your Character Name"]'
# {"characters":[{"id":95465499,"name":"Your Character Name"}]}
```

For a character that is already linked, the terminal client prints it:

```bash
npm run cli
eve> /whoami
# Your Character Name · id 95465499 · 7 scopes
```

Internet access:

- `FIRECRAWL_URL` + `FIRECRAWL_API_KEY` give the agent `fetch_web_page` (one public page as Markdown) and make `web_search` answer from Firecrawl's index. Without them the agent has no way to read the web.
- Tuning: `FIRECRAWL_TIMEOUT_MS`, `FIRECRAWL_MAX_CONTENT_CHARS`, `FIRECRAWL_MAX_FETCHES_PER_TURN`, `FIRECRAWL_MAX_SEARCH_RESULTS`. Loopback and private addresses are refused before egress, and an operator can switch the access off at runtime from Settings.

Model defaults:

- `OPENAI_BASE_URL` is required and is the only source of the endpoint: the API root of an OpenAI Responses-compatible service, without a trailing `/responses`. http and https are both accepted, so a local or LAN gateway works; it must not embed credentials, because the key belongs in `OPENAI_API_KEY` and would otherwise land in every log line that prints the endpoint.
- `OPENAI_PROFILE` declares what that endpoint supports. `openai` enables the full official contract: hosted tool search and Programmatic Tool Calling, `truncation`, encrypted reasoning replay, and `OPENAI_RESPONSE_STATE_MODE=server`. `compatible` sends only the documented core of the Responses API and uses the application-owned substitutes instead — client tool search, the bounded local parallel batch, read subagents on by default — and requires stateless response mode. Pick `compatible` for OpenRouter, ModelHub, LiteLLM, or any other gateway; a gateway that rejects an optional field answers with a 400 rather than degrading quietly.
- `OPENAI_PROVIDER_NAME` (optional) is the name shown in the startup banner and on the browser consent screen, which tells each user who receives their data. Unset, it falls back to the host of `OPENAI_BASE_URL`.
- The selected provider and its API key are process-wide operator settings. Browser users never provide or receive this key; each user gets an isolated opaque session and chat lane while requests share the configured concurrency and rate limits.
- `OPENAI_MODEL=gpt-5.6-sol` is the quality-first default. Use `gpt-5.6-terra` for a capability/cost balance or `gpt-5.6-luna` for latency-sensitive, high-volume deployments. The `gpt-5.6` alias routes to Sol.
- `OPENAI_PROGRAMMATIC_TOOL_CALLING=false` keeps the default direct-tool path. Setting it to `true` opts into provider-entitled hosted programs for exactly nine bounded public-read tools: static counts, batch market prices, wormhole-type comparisons, Scout system searches, compact kill-activity summaries, market-history summaries, system-metric snapshots, doctrine summaries, and dynamic-item summaries. Restart after changing it. See [OpenAI integration](./docs/openai-integration.md) for schemas, budgets, exclusions, real smoke matrices, and rollback.
- `OPENAI_RESPONSE_STATE_MODE=stateless` is the default and rollback path. `server` reuses `previous_response_id`, requires `OPENAI_STORE_RESPONSES=true`, and falls back to canonical SQLite history if the provider state is missing or no longer matches its anchored assistant message.
- `OPENAI_STORE_RESPONSES=false` keeps provider-side Response logs opt-in. Set it to `true` to inspect requests in [OpenAI Responses Logs](https://platform.openai.com/logs?api=responses); storage alone does not switch the state mode.
- `OPENAI_REASONING_EFFORT=auto` preserves EVE Agent's goal-based `low|medium|high` routing. Set `none`, `low`, `medium`, `high`, `xhigh`, or `max` to override it globally.
- `OPENAI_REASONING_MODE=standard` is the normal path. Set `pro` only for difficult quality-first workloads that justify higher latency and token use; Pro is a mode, not a separate model name.
- `OPENAI_TEXT_VERBOSITY=low` keeps chat answers compact; set `medium` if your community wants longer explanations.
- `OPENAI_RESPONSES_TIMEOUT_MS=300000` controls the Responses transport deadline (10s..900s); raise it deliberately when evaluating Pro.
- `OPENAI_RESPONSE_LANGUAGE=Russian` sets the default final-answer language. Aliases like `ru`, `русский`, `en`, `English`, and custom language names are accepted; an explicit user request can override it per answer.

These are process-wide self-hosting controls shared by Telegram, Discord, and CLI. They are not per-chat preferences. See [OpenAI integration](./docs/openai-integration.md) and OpenAI's [GPT-5.6 guide](https://developers.openai.com/api/docs/guides/latest-model).

## EVE SSO Setup (private character data)

The current process configuration requires EVE Developer credentials at startup,
even if an operator initially uses only public data. Character linking itself is
optional: after credentials are configured, public SDE, market, route,
killboard, and OSINT workflows work without linking a character. To unlock
**private ESI** (skills, assets, wallet, location, mail, …), register a free
EVE Developer application (~5 minutes):

1. Open <https://developers.eveonline.com/applications/create> and sign in with
   your EVE account.
2. **Connection Type:** choose *Authentication & API Access*, then select the
   scopes you want to support (or all of them for full parity).
3. **Callback URL:** set it to *exactly* your `EVE_CALLBACK_URL`. For local use:

   ```text
   http://localhost:3000/auth/eve/callback
   ```

4. Copy the **Client ID** and **Secret Key** into `.env`:

   ```env
   EVE_CLIENT_ID=your_client_id
   EVE_CLIENT_SECRET=your_secret_key
   ```

5. Restart. `/login` in the CLI and `/eve_login` in Telegram or Discord now
   return a working SSO link.

## Terminal CLI (no bot token needed)

Talk to the agent directly in your terminal — a third platform adapter beside
Telegram and Discord, driving the same runtime. It needs the same local `.env`
configuration as the app, but no Telegram or Discord bot token:

```bash
npm run cli
```

```text
┌─ EVE AI Agent v4.1.0 · CLI ────────────────────────┐
│ Talk to the agent in your terminal. Commands:      │
│   /login   link an EVE character (opens SSO)       │
│   /whoami  show the active character               │
│   /clear   wipe this conversation                  │
│   /version check project updates                   │
│   /exit    quit                                    │
└────────────────────────────────────────────────────┘
eve> route from Jita to Amarr, is it dangerous?
```

Public tools (SDE lookups, market, route planning with danger analysis,
killboards, OSINT) work without a linked character. Run `/login` to link an EVE
character via SSO and unlock private ESI (skills, assets, location, mail, …).
The full bots still need a Telegram or Discord token; the CLI does not. While
the CLI process is open, `kill_watch` and route monitoring use the same durable
EVE-KILL feed lifecycle as Telegram and Discord. Their SQLite state survives a
restart and eligible route monitors are restored on the next CLI launch. Events
missed while the CLI is closed are not replayed. Heartbeat configuration remains
bot-service-only and is intentionally hidden in the CLI.

Only one bot service or CLI may own a given `DB_PATH` at a time. A DB-adjacent
runtime lock rejects a second process so two feed pollers cannot race the global
cursor.

While the agent works, the CLI shows a **live activity feed** — a brief
"thinking" note and one line per tool/skill as it runs (e.g. `🗄 SDE query`,
`💰 market prices`, `🛰 ESI · …`) — then renders the finished answer:

```text
eve> Сколько стоит Plex?
  💭 Checking PLEX price; resolve type_id, then market price
  🗄  SDE query · query
  💰 market prices · 1 item
PLEX: 4,621,543 ISK (global average — no regional order book).
```

This feed is CLI-only: the Telegram and Discord bots reply with one finished
message and are unaffected. The answer is rendered once from the finalized
(sanitized) text, not streamed token by token, so it is always clean and
complete.

## Scripts

```bash
npm run cli            # interactive terminal agent (no bot token required)
npm run dev            # tsx watch mode (recommended for running the bots)
npm run build          # compile server (tsc)
npm start              # run built app: node dist/app.js
npm run check          # typecheck + tests + lint
npm test               # vitest
npm run smoke          # env, model endpoint, app health checks
npm run smoke:openai   # authenticated provider-aware Responses probe
npm run smoke:eve-tool # authenticated model + EVE SDE tool probe
npm run eval:agent     # deterministic multi-stage orchestration evaluation
npm run eval:web-load  # 100-user durable queue/isolation load harness
npm run update:check   # read-only latest stable release check
npm run db:migrate     # run SQLite migrations
npm run setup          # download and load SDE data
```

On startup the app prints a status banner with database, SDE, HTTP, platform,
OpenAI, and heartbeat state. Structured logger output is timestamped and redacts
recognizable credentials; request-level diagnostics can still contain short user
goals, tool arguments, reasoning summaries, or provider-error snippets. Treat
process logs as private operational data.

## Runtime Smoke Test

Authenticated OpenAI smoke test:

```bash
OPENAI_API_KEY=... npm run smoke:openai
```

EVE tool smoke test:

```bash
OPENAI_API_KEY=... npm run smoke:eve-tool
```

For a DB-only SDE tool check without calling the model:

```bash
EVE_TOOL_SMOKE_MODE=direct npm run smoke:eve-tool
```

The scripts print only sanitized endpoint/model/tool metadata and answer previews. They never log API keys.

## Self-Hosting

See [docs/deployment.md](./docs/deployment.md) for a generic production deployment guide. Before publishing a fork or a release, run `npm run audit:public`, `npm run check`, and `npm run build`. Keep operator-specific server addresses, credentials, logs, certificates, and runbooks outside this repository.

## Documentation

- [AGENTS.md](./AGENTS.md): concise repo map and invariants.
- [ARCHITECTURE.md](./ARCHITECTURE.md): runtime boundaries and request flows.
- [docs/index.md](./docs/index.md): documentation catalog.
- [docs/SECURITY.md](./docs/SECURITY.md): security rules and current gaps.
- [docs/RELIABILITY.md](./docs/RELIABILITY.md): reliability model.
- [docs/deployment.md](./docs/deployment.md): generic self-host guide.
- [docs/openai-integration.md](./docs/openai-integration.md): OpenAI Responses API configuration.
- [docs/generated/db-schema.md](./docs/generated/db-schema.md): SQLite schema reference.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), keep PRs focused, and run `npm run check` when feasible. Good first areas include documentation, reproducible bug fixes, prompt tests, EVE SDE lookups, chat formatting, and self-hosting troubleshooting.

Please do not include secrets, private deployment notes, server IPs, logs, database files, or SDE dumps in issues or pull requests.

## Legal Notice

EVE Online and all related logos, images, and trademarks are the property of CCP hf. This project is a third-party tool and is not affiliated with, endorsed by, or supported by CCP Games.

Use of EVE Online SSO, ESI, SDE, and related game data is subject to the [EVE Online Developer License Agreement](https://developers.eveonline.com/license-agreement). Each self-hosting operator is responsible for accepting and complying with that agreement when creating an EVE Developer application and running an instance.

## Community Showcase Readiness

The ready-to-copy Showcase page and evidence-backed eligibility matrix are in [docs/community-showcase.md](./docs/community-showcase.md). GitHub records the canonical `garshany/eveai` repository's initial public event on 2026-03-24, and its public CI history includes a `master` run on 2026-03-25. The three-month public-age requirement has therefore passed; re-check the current CCP requirements immediately before submitting.

## Open-Source Safety Notice

If you are publishing a fork that previously contained private deployment files or secrets, do not make that repository public as-is. Publish from a clean sanitized export or rewrite history, rotate exposed credentials, and run a secret scan before release.

## License

MIT. See [LICENSE](./LICENSE).
