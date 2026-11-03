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

Run `npm run test:whatsapp-service-auth` for isolated HTTP authentication, ingestion,
and fresh/upgrade database verification. Set `POLO_BOT_ROOT` to the Polo checkout
when running `npm run test:whatsapp-inbox-ingestion` to additionally exercise its
production serializer and HTTP client against the real route on an ephemeral
loopback port. The test uses synthetic credentials and a temporary database,
without starting a native WhatsApp session.
