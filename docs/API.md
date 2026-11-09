# Application API

All routes below are relative to the configured public URL, for example `https://bridge.example.com/wechat-connect/`.

Authenticate from your **backend** using `Authorization: Bearer APPLICATION_TOKEN`. Never embed that credential in frontend JavaScript or a mobile app. Tokens are scoped to one application. The same `user_id` in two applications denotes two different users. Your application must derive `user_id` from its authenticated account rather than accepting a caller-selected identity.

## Create a binding invitation

`POST v1/invitations`

```json
{"user_id":"account-123"}
```

Returns HTTP 201 with `url` and `expires_in: 1800`. Show the returned URL only to that authenticated user. The browser opens the invitation, creates a private session, generates a provider QR code, waits for authorization, and verifies a receipt through WeChat. Do not log the returned URL.

## Read status

`GET v1/users/account-123/status`

The response includes `mode`, optional `login`, and optional `binding`. A binding's state is `awaiting_message`, `confirm_receipt` or `verified`. `last_inbound` and `last_outbound` are Unix timestamps in milliseconds. `error` describes current transport problems. Tokens and provider conversation identifiers are never returned.

## Consume incoming text

`GET v1/events?after=0`

Returns up to 100 events in increasing `id` order from this application's current bindings. Messages received during setup are used for verification. Only messages received after receipt confirmation enter the application event stream.

```json
{"events":[{"id":12,"user_id":"account-123","created_at":1790000000000,"text":"Hello","media_unsupported":false}]}
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

Requires a verified binding and an existing conversation context. The supplied CLI can read notification text from stdin and use the application's stored credential.

```sh
printf '%s' 'Disk usage reached 85% on the example host.' |
  node src/admin.mjs send personal operator disk-alert-example-001
```

Use a stable request ID for each logical notification. API sends are limited to eight attempts per user per minute. WeChat may impose additional limits or require the recipient to send another message first.

## Acceptance and retries

A successful send returns:

```json
{"accepted_by_wechat":true,"delivery_confirmed":false}
```

This reports provider API acceptance, not proof of handset delivery. Repeating a successful `request_id` with the same payload and binding returns `duplicate: true` without resending. Reusing it for different content or after replacing the binding returns HTTP 409. The `test:` prefix is reserved for bridge acknowledgments.

The bridge records the request ID before contacting WeChat. Requests left pending across a crash, and sends that timed out or failed, return `previous_send_uncertain_or_failed` on replay. Check the outcome before deciding whether to send again. Deduplication records expire after seven days. After unlinking, only the ID and deduplication metadata remain for the rest of that window. A queued request rejected with `binding_changed` should be discarded, since its recipient may have changed.

Common errors include `application_auth_required` (401), `event_not_found` (404), `binding_not_verified`, `binding_changed`, `request_id_conflict` (409), `rate_limited` (429), and `send_failed` (502). `interaction_required` can indicate a missing context (409) or a context rejected by WeChat (502). Browser management endpoints additionally enforce the configured Origin and private session cookie.

## Administration

The application-creation endpoint is deliberately outside the public proxy prefix and requires both a loopback connection and the admin token. Use `src/admin.mjs`; do not expose `/admin/` through a reverse proxy. The supplied CLI stores new application credentials in a private directory beside the server configuration and prints only the storage path.
