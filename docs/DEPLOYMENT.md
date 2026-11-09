# Deployment

The supplied unit uses these example paths:

- Application source and dependencies: `/opt/wechat-assistant/app`
- Node runtime: `/opt/wechat-assistant/runtime/bin/node`
- Private configuration: `/etc/wechat-bridge/config.json`
- Database: `/var/lib/wechat-assistant/bridge.sqlite`
- Dedicated non-login account: `wechat-assistant`

Adjust the unit if your host uses other locations. The historical directory name does not make this an AI application; the process is a generic text transport bridge.

## Install

1. Install Node.js 24.16+ and create the dedicated service account and directories.
2. Copy this repository's `src/`, `web/`, `package.json` and `package-lock.json` into the application directory; run `npm ci --ignore-scripts`. Keep deployed code and dependencies root-owned and readable by the service account.
3. As an administrator, initialize configuration once:

   ```sh
   node src/admin.mjs init https://bridge.example.com/wechat-connect/
   ```

   This creates random admin and encryption keys, binds to loopback port 8318, and defaults to test mode. Set configuration ownership to `root:wechat-assistant` with mode `0640`. Its parent directory should be `0750` with the same group. Do not regenerate the encryption key when upgrading.

4. Install `deploy/wechat-bridge.service`, reload systemd and enable/start the service. Confirm `/healthz` on the loopback port reports `ok` and no other interface listens on port 8318.
5. Include `deploy/nginx-location.conf` only in the matching HTTPS virtual host. Validate Nginx configuration before reloading it. The public URL and location prefix must match exactly. Existing application routing can remain intact.
6. Create an application and its user's invitation:

   ```sh
   node src/admin.mjs app-create personal "Personal tools"
   node src/admin.mjs invite personal operator
   ```

   Application credentials are stored privately beside server configuration. The second command prints a one-use binding URL; give it only to its intended user.
7. The user opens the URL, generates the QR code, scans it using WeChat and confirms authorization. If WeChat requests a pairing code, submit it through the page. The user then sends `测试` to the ClawBot and enters the six-digit code received in the reply. Until that succeeds, do not report the channel as verified.

## Existing-application integration

Keep the bridge in test mode while independently verifying authorization, inbound and outbound delivery. Later, an authenticated application's settings screen can request an invitation from its backend and open the returned binding page. The backend consumes events and returns replies using [the API](API.md).

Switch configuration `mode` to `relay` and restart only when the consumer is ready. Each provider connection should have one running poller; do not run multiple bridge processes against the same provider credentials or live database. Horizontal scaling needs explicit worker leases and is outside this initial release.

For automated notifications, use the `send` command shown in the [API instructions](API.md). Run it where the application credential is available, and reuse the same request ID when retrying one notification.

## Operation and rollback

Check `systemctl status wechat-bridge` and `journalctl -u wechat-bridge`. Logs intentionally omit tokens and message contents. The supplied process limits are 192 MiB RAM, 64 MiB swap and 25% of one CPU. Actual idle memory must be checked on the target host.

Back up private configuration and the SQLite database together. Use SQLite's backup API or stop the bridge briefly for a consistent copy; a live WAL-mode database cannot be backed up safely by copying only the main file. Encrypt backups, restrict access and define a retention policy. Users must be able to remove their connections. API key rotation and a self-service application-admin interface are not implemented in this initial version.

To roll back deployment, stop/disable `wechat-bridge`, remove only its Nginx include, validate and reload Nginx, and retain private data until deciding whether it should be restored or deleted. Existing application code need not change.
