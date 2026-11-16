# WhatsApp bot ingestion

## Service credential

`POST /api/whatsapp/inbound` and the exact
`GET /api/whatsapp/takeover/%2B<phone-digits>` request on the main API (`:3001`)
accept the dedicated `X-FloCafe-Inbox-Key` header. Configure
`FLOCAFE_INBOX_SERVICE_KEY` in the FloCafe process environment and in the bot
environment with the same secret: 32 random bytes encoded as exactly 64 lowercase
hexadecimal characters. Generate it using a cryptographically secure generator and
deliver it through your secret manager. Do not commit it, log it, or store it in the
FloCafe settings database.
The Server App proxy (`:3003`) does not expose this route.

The [service authentication middleware](../../main/middleware/whatsapp-service-auth.ts)
compares equal-length credentials with `timingSafeEqual`. Missing, empty, malformed,
or incorrect credentials return HTTP 401. There is no fallback to
`assistant_api_key`, `ASSISTANT_API_KEY`, JWT, passwords, or PINs. The key grants
only inbound ingestion and read-only takeover state for one explicitly addressed
phone; it does not grant message reads, replies, settings, orders, or human permissions.

The dispatch in [requireAuth](../../main/server.ts) requires exactly `POST` and
`/api/whatsapp/inbound`, or `GET` and `/api/whatsapp/takeover/%2B<8-15 digits>`.
Case variants, trailing slashes, child paths, malformed phone paths, and prefix
lookalikes do not receive service authorization. Query parameters do not change the
path. Human JWT access to takeover state remains available. Other API routes retain
their existing authentication and permission checks; takeover and release writes
remain human-authorized.

## Configuration, rotation, and revocation

1. Provision a distinct credential for each installation, separate from human
   authentication and any bot reply-server credential.
2. Inject it into both process environments. FloCafe does not load a repository
   `.env` automatically; the launcher or service manager must supply the variable.
3. Apply environment changes by restarting the affected processes in an approved
   maintenance window. Editing an env file does not alter an already running process.
4. To rotate, replace the FloCafe value and apply it, then replace the bot value and
   apply it. There is no overlap or previous-key grace period; ingestion fails during
   a mismatch. Coordinate retries with message persistence requirements.
5. To revoke, remove the FloCafe variable and apply the environment change. All
   ingestion and takeover-state reads are rejected until a new valid credential is
   configured. While the bot cannot verify takeover state, it suppresses automatic
   replies rather than risk speaking over a human-owned conversation.

Use loopback locally or TLS/an encrypted private tunnel between hosts. The key is a
reusable secret, not transport encryption. Remove obsolete database-stored
`assistant_api_key` values through an approved maintenance procedure; this endpoint
ignores them, but older deployed builds may still trust them.

## Ingestion and human inbox boundaries

The [route](../../main/routes/whatsapp.ts) validates the request using the
[ingestion contract](../../main/whatsapp-inbox-ingestion.ts). All seven fields are
required strings; unknown fields are rejected:

| Field | Contract |
| --- | --- |
| `phone_e164` | Valid international phone with leading `+`, no JID suffix or formatting. |
| `direction` | `inbound` for `user_message`; `outbound` for replies. |
| `kind` | `user_message`, `bot_reply`, or `agent_reply`. |
| `body` | Nonblank text, at most 65536 JavaScript string code units. |
| `external_message_id` | Nonblank stable event ID, at most 256 code units, no outer whitespace. |
| `status` | `queued`, `seen`, `typing`, `sent`, `delivered`, `read`, or `failed`. |
| `timestamp` | Valid UTC ISO timestamp with milliseconds: `YYYY-MM-DDTHH:mm:ss.sssZ`. |

Invalid bodies return HTTP 400 before database writes. Success returns HTTP 200
with `{ ok: true, id }`. The supplied event timestamp is stored in `queued_at` and
in the matching status timestamp column, in canonical SQLite UTC second precision.
The full timestamp remains part of the event fingerprint, so differing milliseconds
are not silently treated as identical events.

Deduplication is scoped to `(phone_e164, direction, external_message_id)` across
all three external kinds. An identical retry returns the original row ID without
another write. Reusing that identity with changed content, kind, status, or timestamp
returns HTTP 409 (`inbox_event_conflict`); this endpoint is not an event-update API.
The insertion and conflict check run in one transaction and a partial unique index
also enforces the identity. Native WhatsApp sends and their attempt IDs are separate.

Migration 126 expands the kind constraint without removing the five native kinds.
It retains existing messages, attempt records, foreign keys, indexes, triggers, and
the message ID sequence. Fresh installs run the same migration chain as upgrades.

The external bot must resolve a phone-number JID (including a PN alternate for LID
messages) before ingestion. LID digits are not phone numbers. Missing phone identity,
event ID, or timestamp must not be replaced with invented identifiers. The Polo bot
skips such inbound mirrors with an explicit warning and continues normal handling.
When the inbox client is configured, it queries the persisted takeover state before
processing and again immediately before each automatic send. A `taken` state pauses
the bot for that phone; state lookup failure suppresses the reply (fail-closed).
The FloCafe inbox list returns this persisted state and refreshes it periodically.

Human inbox reads and takeover/release actions retain `whatsapp.manage` authorization.
Human replies are accepted only while the specific phone is taken over. The API
forwards them to the bot's `POST /api/v1/inbox/reply`; FloCafe does not open a
WhatsApp session or send through its own socket for these replies. Set
`WHATSAPP_BOT_REPLY_URL` (locally, `http://127.0.0.1:3004/api/v1/inbox/reply`) and
`WHATSAPP_BOT_REPLY_KEY` in the FloCafe process environment. The latter must match
the bot's `ASSISTANT_API_KEY`. HTTP is accepted only for literal loopback hosts;
otherwise use HTTPS. Redirects are rejected, requests time out after 10 seconds, and
the key is never returned in API errors. The bot mirrors successful human replies
back to the inbox as `agent_reply`. Releasing takeover restores automatic replies.

Changing environment values requires restarting the affected FloCafe and bot
processes. This implementation has been validated with isolated tests/builds; it is
not active in a running desktop app until the configuration is injected and that app
is restarted. Do not connect the same WhatsApp number to a second Baileys session.

## Bot bridge v1 connection hardening

The outbound desktop bridge is a single-installation connection, not a tenant router.
The bot authenticates the WebSocket upgrade and accepts the first authenticated
socket; concurrent or second upgrades receive HTTP 409 until its owner disconnects.
The internal connection generation binds requests, responses, timers and callbacks
to their originating socket without changing protocol-1 frame fields. A stale
response or close cannot complete or reject a successor's work. A disconnected
owner's pending requests fail with a controlled error. The client reconnects using
bounded exponential backoff with jitter; it does **not** replay commands or
in-flight requests. A timeout, lost response, or close after sending is an
**uncertain outcome**, not proof that a human reply or inbox write did not happen.
Reconcile persisted evidence before any retry. There is no durable deduplication
ledger in this connection layer.

Each side defaults to 16 KiB maximum JSON message after reassembly (never increase this without a
protocol review), 100 pending outgoing calls, 32 concurrent incoming operations,
64 KiB maximum `bufferedAmount` before enqueue, and 30 s WebSocket control
ping/pong. A missing pong on the next interval detaches the dead socket before
termination. Existing protocol-1 `ws` clients auto-pong. Over-limit outbound
messages fail immediately rather than building an application queue; oversized
incoming frames disconnect. The bot reserves one pending slot for takeover and
blocklist against inbound-record pressure when the pending limit exceeds one;
the desktop reserves one active slot
for takeover/blocklist against record pressure when the active limit exceeds one.
No business operations are reordered. Response errors expose fixed codes, not
request contents or raw exceptions. Do not log full frames, phone numbers, QR
material or credentials.

The former one-shot "test connection" probe now reads this authenticated live
connection state; it must not open a competing socket merely to test reachability.
An unconnected bridge reports false until its own handshake succeeds.

Technical developer-only environment overrides on **each process**:
`FLOCAFE_BRIDGE_MAX_PAYLOAD_BYTES` (256–16384),
`FLOCAFE_BRIDGE_MAX_PENDING` (1–100),
`FLOCAFE_BRIDGE_MAX_ACTIVE` (1–100),
`FLOCAFE_BRIDGE_MAX_BUFFERED_BYTES` (256–1048576), and
`FLOCAFE_BRIDGE_HEARTBEAT_MS` (20–120000). Integers outside those ranges
fail configuration validation. The desktop operator pairs through encrypted
safeStorage UI settings, not environment editing. Keep matching frame limits
when debugging; do not use these flags to onboard a store. Validate locally with
`npm run test:whatsapp-bot-bridge-config`; the installed desktop remains unchanged
until a separately approved rebuild/restart. Catalog business v2 is a separate,
explicit opt-in; no v2 order operation is enabled.

## Read-only catalog business v2

The existing connection can negotiate only `catalog.get_page`, with the machine
scope `catalog.view`. Protocol-1 ready, Inbox, takeover, blocklist and human replies
remain independent. No order creation, receipts, payment or stock mutation is
implemented on this channel. Catalog reads do not use an owner JWT or password.

Provision a random 32-byte catalog key separately from the transport token and
human-reply credential. On the bot, select `FLOCAFE_BUSINESS_TRANSPORT=bridge`, set
`FLOCAFE_BUSINESS_INSTALLATION_ID` and `FLOCAFE_CATALOG_SERVICE_KEY` (64 lowercase
hex characters), and enable its catalog provider. The default transport is the
legacy `http`; selecting bridge never silently falls back to HTTP. Legacy order
submission remains unchanged and is not made remotely available by this feature.

On the desktop, the existing owner-protected `POST /api/whatsapp/bot-bridge/config`
accepts optional `businessCatalog: { installationId, key }` beside `url` and
`token`. These settings share the encrypted safeStorage file. Omission preserves
the prior catalog settings; explicit `null` removes them. The key is write-only:
configuration/status APIs and the internal transport credential getter do not
return it. Provisioning uses the authorized local settings channel; store staff
do not need to edit an environment file. No new catalog setup UI is provided.

The bot sends a signed offer after protocol-1 ready. Acceptance and confirmation
bind the phase, installation, socket session, bot nonce, fresh desktop nonce and
catalog-only capabilities with HMAC-SHA256. Failed or absent negotiation cannot
authorize catalog access. Reconnect requires a new negotiation; old callbacks,
responses and cached catalogs cannot acquire the successor's authority.

The catalog source reuses active-product selection, variants and effective
product/category add-on groups used by the HTTP product reader, inside one SQLite
read transaction. Immutable snapshots last 60 seconds, with at most four stored
snapshots, 2 MiB per snapshot and 10,000 product/group rows. Pages respect both the
requested limit (1–25 products) and the complete JSON frame budget, at most 16 KiB.
Groups can arrive on later or group-only pages; the bot assembles and validates
the complete snapshot before reusing its existing catalog normalizer. When v2
is configured, the byte budget must also fit the largest valid handshake frame;
insufficient settings are rejected before saving/connecting. Small v1-only
budgets are still valid and are not silently increased.

The bot limits a complete refresh to 30 seconds, 2 MiB and 1,024 pages, rejects
cursor loops, duplicate identities and inconsistent revisions/references, and
allows one fresh-snapshot restart after expiration. A disconnected bridge does
not expose its cached catalog. In required-integration mode, selected bridge
catalog capabilities must be ready before automated replies are allowed.
Critical v1 operations retain their reserved capacity when limits exceed one.

Unsupported catalog data fails closed rather than being silently changed:
fractional-cent prices, weighted/fractional products, multiple quantities per
add-on, conflicting effective group definitions, or a single item that cannot
fit the contract/frame budget. Read-only snapshots and machine keys are not a
durable mutation ledger or a deployment/provisioning service.

Run `npm run test:catalog-bridge` for source, snapshot and wire tests. The Polo
repository also provides `npm run test:catalog:process`; set
`POLO_CATALOG_TEST_BOT` and `POLO_CATALOG_TEST_FLO` to sanitized, compiled copies
with their test dependencies. That harness uses two real processes and loopback
WebSockets, synthetic machine credentials and an in-memory SQLite database; it
does not start WhatsApp or open an operational database. Remote WSS/TLS and store
deployment require separate validation.

## Operational diagnostic privacy

The bot's integrated runtime writes metadata-only conversation diagnostics; production
also forces that mode for its file logger. Order create/append/discount failures in
this POS use controlled diagnostic codes rather than raw exception objects. These
changes do not remove business records or alter authorization and payment rules.
Historical log files are not deleted: restrict access, retain encrypted evidence
where required, and approve retention/expunging separately. No request bodies,
phone numbers, addresses, credentials or QR material belong in operational logs.

The installed `libsignal@6.0.0` and Baileys SDKs require the versioned,
hash-pinned `scripts/patch-dependency-privacy.cjs` privacy patch. `npm ci`
runs it from `postinstall`, after the existing Electron/native/Snap hooks. It
refuses an unknown version, source hash or hunk and checks every installed copy
before writing; repeated application is safe. `npm start` verifies the patch
before launching Electron. The existing checkout's `node_modules` was not
patched; `npm start` will refuse to launch until an authorized installation or
patch application. The `beforePack` hook also refuses unpatched dependencies;
`afterPack` checks exact hashes inside the resulting `app.asar` before accepting
the package. The verifier has been exercised against the payload extracted from
a real Windows x64 NSIS build, including rejection of a tampered archive. Do not use
`--ignore-scripts` as a deploy/install
shortcut: it skips the patch and Electron/native hooks; run
`node scripts/patch-dependency-privacy.cjs` followed by `--check` only after a
separately justified skipped-scripts install. Direct Electron launches bypass
the npm start gate and must verify first. No lockfile or crypto algorithm changes.
The SDK-specific logger retains severity and a controlled `sdk_log` code, but
discards all variable arguments and child bindings. The direct console sites in
libsignal and Baileys metadata/temporary-file diagnostics now emit fixed codes;
there is no global console interception. The original Baileys default Pino
logger is patched independently because several SDK modules import it directly.
The bot's optional `@itsliaaa/baileys` fork uses a separate Rust/Starforge stack,
not `libsignal`; do not equate their test coverage.

The isolated `libsignal` session and encrypt/decrypt tests prove local behavior
only, not network WhatsApp delivery. A full Windows x64 clean install, automatic
postinstall patching, native Electron probe and real NSIS package have been
validated in an isolated build tree with compatible MSVC/MSBuild/Windows SDK.
The packaged native module and patched dependencies were exercised in Node mode
from the extracted installer payload, not by installing or launching the GUI.
This does not certify every platform or an in-use installation.
`--ignore-scripts` is not acceptance evidence.
Historical logs remain untouched. Raw diagnostics in unrelated POS routes and
possible obscured Starforge paths were not certified by this patch.

Detached local work continues to consume the active-operation budget until it
settles, even if a new socket is connected. A handler that never settles can keep
capacity occupied; transport timeout is not cancellation of business effects.
A pending human reply rejected after disconnect is reported as
`bridge_disconnected_outcome_unknown`; it is not automatically resent. The plain
`bridge_disconnected` rejection is reserved for a reply not started on a connection.

Run `npm run test:operational-privacy` and `npm run test:whatsapp-bot-bridge-config`
for the relevant isolated diagnostics and transport regressions.

Run `npm run test:whatsapp-service-auth` for isolated HTTP authentication, ingestion,
and fresh/upgrade database verification. Set `POLO_BOT_ROOT` to the Polo checkout
when running `npm run test:whatsapp-inbox-ingestion` to additionally exercise its
production serializer and HTTP client against the real route on an ephemeral
loopback port. The test uses synthetic credentials and a temporary database,
without starting a native WhatsApp session.
