# Linux resource monitor

This optional example checks CPU, load, memory, swap, OOM kills, disk space and inode usage. A systemd timer runs the script once a minute. The monitor calls the bridge's application API to send WeChat notifications.

General warnings, CPU, load and swap alerts require three consecutive samples. Critical memory and disk shortages are eligible for an alert immediately. Three lower-severity samples trigger a recovery or downgrade. One notification can cover multiple resource changes, and an ongoing alert is eligible for a reminder every six hours.

## Configure

Run with Python 3.9 or newer on Linux with system time zone data installed. Keep settings in the private file `/etc/server-resource-monitor/config.json`. The script writes its state to `/var/lib/server-resource-monitor` and rotating summaries to `/var/log/server-resource-monitor`. Give the service account access to these paths.

Use the following keys in the settings file:

| Key | Value |
| --- | --- |
| `mounts` | Array of absolute mount paths to monitor. |
| `limits.cpu_warning_pct` | CPU warning threshold. |
| `limits.cpu_critical_pct` | CPU critical threshold. |
| `reminder_seconds` | Set to `21600` for six-hour reminders. |
| `bridge.base_url` | The bridge URL, including its configured path prefix. Use HTTPS or a literal HTTP loopback address for a local bridge. |
| `bridge.application_token` | The private token for the application that owns the binding. |
| `bridge.user_id` | The application user whose WeChat is connected. |

Keep the bridge settings and runtime state outside version control. An existing timer can keep its one-minute schedule. Point the corresponding service's `ExecStart` to `/usr/bin/python3 /path/to/monitor.py`. For a new timer, set `OnBootSec=1min` and `OnUnitActiveSec=1min` for a matching oneshot service.

## Check notification status

Run `python3 monitor.py --status` to inspect the latest metrics and notification state. `python3 monitor.py --test-notification` requests a real test message. An `accepted_by_wechat` result means the API accepted it. Check the phone for delivery.

The recipient needs a connected binding and a conversation context. If the bridge returns `interaction_required`, send a message from WeChat to ClawBot to create or refresh that context.

Each pending batch is saved before its first send. Retries keep the same request ID and text, including after a process restart. Transient failures retry with a delay that increases from one to five minutes. A bridge rejection or an unconfirmed outcome never advances the last accepted notification.

When the bridge reports that a previous send is uncertain or that an ID conflicts, the monitor records the batch under `last_unconfirmed_notification` and stops retrying that ID. New alert transitions and scheduled reminders can still proceed. The same rule applies when a pending batch reaches six days, before the bridge's seven-day deduplication window expires. Changing the configured destination while a batch is pending requires review, so the monitor does not redirect that batch.

## Run the tests

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s examples/resource-monitor -v
```

The tests mock the bridge and do not send WeChat messages.
