# Application API

All routes below are relative to the configured public URL, for example `https://bridge.example.com/wechat-connect/`.

Authenticate from your **backend** using `Authorization: Bearer APPLICATION_TOKEN`. Never embed that credential in frontend JavaScript or a mobile app. Tokens are scoped to one application. The same `user_id` in two applications denotes two different users. Your application must derive `user_id` from its authenticated account rather than accepting a caller-selected identity.

## Create a binding invitation

`POST v1/invitations`

```json
{"user_id":"account-123"}
```

Returns HTTP 201 with `url` and `expires_in: 1800`. Show the returned URL only to that authenticated user. The browser opens the invitation, creates a private session, generates a provider QR code, and waits for WeChat to confirm authorization. If WeChat requests a pairing code, submit it in the browser. Do not log the returned URL.

Set `reuse_existing: true` in relay mode to let the browser offer reuse of a connection it is already authorized to manage. The user must explicitly approve the named application. A share gives one application exclusive access to new inbound texts, plus permission to reply and send notifications. It leaves the original application connected for outbound sends. Prior events, provider credentials and the original application identity are private.

## Read status

`GET v1/users/account-123/status`

The response includes `mode`, optional `login`, and optional `binding`. A binding's state is `connected` after WeChat confirms authorization or the user approves a share. `connection_id` identifies that authorization. `shared` indicates a delegated inbox. `last_inbound` records the last incoming message and `last_outbound` records the last outgoing message accepted by WeChat. Both are Unix timestamps in milliseconds and may be null. `error` describes current transport problems, including whether the authorization needs renewal. Tokens and provider conversation identifiers are never returned.

## Consume incoming text

`GET v1/events?after=0`

Returns up to 100 events in increasing `id` order from this application's current bindings. Messages from new bindings enter the event stream as soon as the connection is established. Messages withheld by the old setup flow stay private after an upgrade.

```json
{"events":[{"id":12,"user_id":"account-123","connection_id":"opaque-connection-id","created_at":1790000000000,"text":"Hello","media_unsupported":false}]}
```

Persist your consumer cursor after processing, and deduplicate work by event `id`. Records expire after seven days; consumers must not fall behind that retention window. In `test` mode the bridge already sends a fixed acknowledgment; switch to `relay` only after your application consumer and reply path are ready.

## Reply to an incoming event

`POST v1/events/12/reply`

```json
{"request_id":"reply-event-12","text":"Your application's answer"}
```

The bridge derives the recipient and conversation context from the event. It checks the application's ownership and the binding generation. Rebinding makes old events invalid reply targets.

## Send a proactive notification

`POST v1/users/account-123/send`

```json
{"request_id":"task-567-completed","text":"Your task has finished."}
```

Requires a connected binding and an existing conversation context. The supplied CLI can read notification text from stdin and use the application's stored credential.

```sh
printf '%s' 'Disk usage reached 85% on the example host.' |
  node src/admin.mjs send personal operator disk-alert-example-001
```

Use a stable request ID for each logical notification. API sends are limited to eight attempts per user per minute. WeChat may impose additional limits or require the recipient to send another message first.

Pass the current `connection_id` with a notification to prevent a queued send from reaching a replacement connection.

## Unbind

`POST v1/users/account-123/unbind` with an empty JSON object disconnects this application's user and invalidates its outstanding invitations and browser sessions. Removing a delegated inbox leaves the primary connection available for its own notifications. The primary user can revoke the share on their binding page.

## Acceptance and retries

A successful send returns:

```json
{"accepted_by_wechat":true,"delivery_confirmed":false}
```

This reports provider API acceptance, not proof of handset delivery. Repeating a successful `request_id` with the same payload and binding returns `duplicate: true` without resending. Reusing it for different content or after replacing the binding returns HTTP 409. The `test:` prefix is reserved for bridge acknowledgments.

The bridge records the request ID before contacting WeChat. Requests left pending across a crash, and sends that timed out or failed, return `previous_send_uncertain_or_failed` on replay. Check the outcome before deciding whether to send again. Deduplication records expire after seven days. After unlinking, only the ID and deduplication metadata remain for the rest of that window. A queued request rejected with `binding_changed` should be discarded, since its recipient may have changed.

Common errors include `application_auth_required` (401), `event_not_found` (404), `binding_not_connected`, `binding_changed`, `request_id_conflict` (409), `rate_limited` (429), and `send_failed` (502). `interaction_required` can indicate a missing context (409) or a context rejected by WeChat (502). Browser management endpoints additionally enforce the configured Origin and private session cookie.

## Administration

The application-creation endpoint is deliberately outside the public proxy prefix and requires both a loopback connection and the admin token. Use `src/admin.mjs`; do not expose `/admin/` through a reverse proxy. The supplied CLI stores new application credentials in a private directory beside the server configuration and prints only the storage path.
