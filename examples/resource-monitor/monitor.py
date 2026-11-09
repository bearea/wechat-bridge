#!/usr/bin/python3
"""Small host resource monitor. No dependencies or listening network ports."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import logging
import logging.handlers
import os
from pathlib import Path
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from uuid import uuid4
from zoneinfo import ZoneInfo

CONFIG = Path('/etc/server-resource-monitor/config.json')
STATE = Path('/var/lib/server-resource-monitor')
LOGS = Path('/var/log/server-resource-monitor')
MIB = 1024 ** 2
GIB = 1024 ** 3
# Stop before the bridge's seven-day deduplication window can expire.
PENDING_MAX_AGE = 6 * 86400
BRIDGE_ERRORS = {
    'application_auth_required', 'binding_changed', 'binding_not_connected', 'binding_not_verified',
    'interaction_required', 'previous_send_uncertain_or_failed', 'rate_limited', 'rebind_required',
    'request_id_conflict', 'send_failed', 'service_unavailable',
}
REVIEW_REQUIRED = {
    'previous_send_uncertain_or_failed', 'request_id_conflict', 'pending_expired_review_required',
}


def atomic_json(path, obj):
    temp = path.with_suffix('.tmp')
    with temp.open('w') as handle:
        json.dump(obj, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    temp.replace(path)


def cpu_ticks():
    # guest ticks already belong to user/nice; do not count them twice.
    fields = [int(x) for x in Path('/proc/stat').read_text().splitlines()[0].split()[1:9]]
    return [sum(fields), fields[3] + fields[4]]


def collect(previous, mounts):
    now = time.time()
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    ticks = cpu_ticks()
    old = previous.get('metrics', {})
    old_ticks = old.get('cpu_ticks')
    if old.get('boot_id') != boot or not old_ticks or now - old.get('timestamp', 0) > 180:
        old_ticks = ticks
        time.sleep(1)
        ticks = cpu_ticks()
    total_delta = ticks[0] - old_ticks[0]
    idle_delta = ticks[1] - old_ticks[1]
    cpu = max(0, min(100, 100 * (1 - idle_delta / total_delta))) if total_delta > 0 else 0
    mem = {}
    for line in Path('/proc/meminfo').read_text().splitlines():
        key, value = line.split(':', 1)
        mem[key] = int(value.strip().split()[0]) * 1024
    vm = dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())
    disks = {}
    for mount in mounts:
        try:
            stat = os.statvfs(mount)
            used = stat.f_blocks - stat.f_bfree
            available = stat.f_bavail
            disks[mount] = {
                'used_pct': 100 * used / max(1, used + available),
                'free_bytes': available * stat.f_frsize,
                'inode_used_pct': 100 * (stat.f_files - stat.f_ffree) / max(1, stat.f_files),
            }
        except OSError:
            disks[mount] = {'unavailable': True}
    return {
        'timestamp': now, 'boot_id': boot, 'cpu_ticks': ticks,
        'cpu_pct': round(cpu, 2), 'cores': os.cpu_count() or 1,
        'load5': os.getloadavg()[1],
        'mem_available_bytes': mem['MemAvailable'], 'mem_total_bytes': mem['MemTotal'],
        'mem_available_pct': 100 * mem['MemAvailable'] / mem['MemTotal'],
        'swap_used_pct': 100 * (mem['SwapTotal'] - mem['SwapFree']) / max(1, mem['SwapTotal']),
        'oom_kills': int(vm.get('oom_kill', 0)), 'disks': disks,
    }


def assess(m, old, limits):
    """Return (severity, measured detail) for each independently tracked resource."""
    def high(value, warning, critical):
        return 2 if value >= critical else 1 if value >= warning else 0
    signals = {
        'cpu': (high(m['cpu_pct'], limits['cpu_warning_pct'], limits['cpu_critical_pct']),
                'CPU 使用率 %.1f%%' % m['cpu_pct']),
        'load': (high(m['load5'] / m['cores'], 1.5, 3),
                 '5 分钟负载 %.2f，%s 核 CPU' % (m['load5'], m['cores'])),
    }
    available = m['mem_available_bytes']
    pct = m['mem_available_pct']
    severity = 2 if pct < 5 or available < 100 * MIB else 1 if pct < 15 or available < 256 * MIB else 0
    signals['memory'] = (severity, '可用内存 %.0f MiB（%.1f%%）' % (available / MIB, pct))
    severity = high(m['swap_used_pct'], 80, 95) if pct < 20 else 0
    signals['swap'] = (severity, 'Swap 使用 %.1f%%，可用内存 %.1f%%' % (m['swap_used_pct'], pct))
    for mount, disk in m['disks'].items():
        if disk.get('unavailable'):
            signals['disk:' + mount] = (2, '无法读取文件系统 ' + mount)
            continue
        free = disk['free_bytes']
        severity = max(high(disk['used_pct'], 85, 95), 2 if free < 512 * MIB else 1 if free < 2 * GIB else 0)
        signals['disk:' + mount] = (severity, '%s 磁盘已用 %.1f%%，剩余 %.2f GiB' % (mount, disk['used_pct'], free / GIB))
        signals['inode:' + mount] = (high(disk['inode_used_pct'], 85, 95),
                                    '%s 文件数量配额已用 %.1f%%' % (mount, disk['inode_used_pct']))
    delta = 0
    if old.get('boot_id') == m['boot_id']:
        delta = max(0, m['oom_kills'] - old.get('oom_kills', m['oom_kills']))
    signals['oom'] = (2 if delta else 0, '检测到内存耗尽导致进程被系统终止 %s 次' % delta)
    return signals


def transition(record, severity, detail, now, sustained=3, recovery=3, reset=False, slow=False):
    r = dict(record)
    r.setdefault('level', 0)
    r.setdefault('notified_level', 0)
    if reset or r.get('candidate') != severity:
        r['count'] = 0
    r.update(candidate=severity, count=r.get('count', 0) + 1, detail=detail)
    required = recovery if severity < r['level'] else sustained if severity == 1 or slow else 1
    if r['count'] >= required:
        if severity != r['level']:
            r['since'] = now
        r['level'] = severity
    return r


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A push credential must never be forwarded to another host.
        return None


def bridge_destination(config):
    settings = config.get('bridge')
    if not settings:
        return None
    if not isinstance(settings, dict):
        raise ValueError('invalid bridge settings')
    base = settings.get('base_url', '')
    token = settings.get('application_token', '')
    user = settings.get('user_id', '')
    if not all(isinstance(value, str) for value in (base, token, user)):
        raise ValueError('invalid bridge settings')
    url = urllib.parse.urlsplit(base)
    loopback = url.hostname in ('127.0.0.1', '::1')
    if not (url.scheme == 'https' or (url.scheme == 'http' and loopback)) or not url.hostname:
        raise ValueError('invalid bridge URL')
    if url.username is not None or url.password is not None or '?' in base or '#' in base or re.search(r'\s', base):
        raise ValueError('invalid bridge URL')
    port = url.port
    if port == 0:
        raise ValueError('invalid bridge port')
    if not re.fullmatch(r'[A-Za-z0-9_-]+', token) or not re.fullmatch(r'[A-Za-z0-9_.@+-]{1,128}', user):
        raise ValueError('invalid bridge credentials')
    if user in ('.', '..'):
        raise ValueError('invalid bridge user')
    endpoint = base.rstrip('/') + '/v1/users/' + urllib.parse.quote(user, safe='') + '/send'
    return endpoint, token


def response_object(response):
    try:
        payload = json.loads(response.read(65536))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def send(destination, request_id, text):
    endpoint, token = destination
    data = json.dumps({'request_id': request_id, 'text': text}).encode()
    try:
        req = urllib.request.Request(endpoint, data=data, headers={
            'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        })
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
        with opener.open(req, timeout=12) as response:
            payload = response_object(response)
            if response.status == 200 and payload.get('accepted_by_wechat') is True:
                return True, 'accepted_by_wechat'
            return False, 'bridge_invalid_response'
    except urllib.error.HTTPError as error:
        with error:
            code = response_object(error).get('error')
        if isinstance(code, str) and code in BRIDGE_ERRORS:
            return False, code
        return False, f'bridge_http_{error.code}'
    except (OSError, ValueError):
        # Exception messages can contain the URL or request data.
        return False, 'bridge_transport_error'


def format_body(host, records, metrics):
    when = dt.datetime.fromtimestamp(metrics['timestamp'], ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M:%S')
    labels = {0: '恢复', 1: '资源紧张', 2: '严重不足'}
    lines = ['服务器：' + host, '时间：' + when + '（北京时间）', '']
    for key, r in records.items():
        lines.append('- [%s] %s' % (labels[r['level']], r['detail']))
    lines += ['', '当前 CPU %.1f%%；可用内存 %.0f MiB（%.1f%%）。' % (
        metrics['cpu_pct'], metrics['mem_available_bytes'] / MIB, metrics['mem_available_pct'])]
    return '\n'.join(lines)


def notify_due(state, config, now, path):
    try:
        destination = bridge_destination(config)
    except ValueError:
        return 'invalid_bridge_config'
    if not destination:
        return 'not_configured'

    fingerprint = hashlib.sha256(json.dumps(destination).encode()).hexdigest()
    pending = state.get('pending_notification')
    if pending and pending['destination'] != fingerprint:
        return 'destination_changed_review_required'

    previous_status = state.get('notification_status', 'configured')
    if previous_status in ('not_configured', 'invalid_bridge_config', 'destination_changed_review_required'):
        previous_status = 'configured'
    if now < state.get('next_send_attempt', 0):
        return previous_status
    if not pending:
        due = {}
        for key, r in state['resources'].items():
            attempted = r.get('unconfirmed') or {'level': r.get('notified_level', 0), 'at': r.get('last_notified', 0)}
            if r['level'] != attempted['level'] or (
                    r['level'] and now - attempted['at'] >= config['reminder_seconds']):
                due[key] = r
        if not due:
            return previous_status
        pending = {
            'request_id': 'resource-monitor:' + uuid4().hex,
            'text': format_body(socket.gethostname(), due, state['metrics']),
            'levels': {key: record['level'] for key, record in due.items()},
            'created_at': now,
            'destination': fingerprint,
        }
        encoded = pending['text'].encode()
        if len(encoded) > 3500:
            pending['text'] = encoded[:3497].decode(errors='ignore') + '…'
        state['pending_notification'] = pending
        # Persist the exact batch before the bridge can accept it.
        atomic_json(path, state)

    if now - pending['created_at'] >= PENDING_MAX_AGE:
        success, result = False, 'pending_expired_review_required'
    else:
        success, result = send(destination, pending['request_id'], pending['text'])

    if success or result in REVIEW_REQUIRED:
        for key, level in pending['levels'].items():
            record = state['resources'][key]
            if success:
                record.update(notified_level=level, last_notified=now)
                record.pop('unconfirmed', None)
            else:
                record['unconfirmed'] = {'level': level, 'at': now}
        if not success:
            state['last_unconfirmed_notification'] = {
                'request_id': pending['request_id'], 'status': result, 'at': now, 'levels': pending['levels'],
            }
        state.pop('pending_notification')
        state['send_failures'] = 0
        state['next_send_attempt'] = now + 60
    else:
        state['send_failures'] = state.get('send_failures', 0) + 1
        delay = min(300, 60 * 2 ** min(state['send_failures'] - 1, 3))
        state['next_send_attempt'] = now + delay
    return result


def run(config, state_dir=STATE, log_dir=LOGS):
    state_dir.mkdir(parents=True, exist_ok=True)
    log_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = state_dir / 'state.json'
        if path.exists():
            # Corruption must be visible as a failed check, not silently reset alerts.
            state = json.loads(path.read_text())
        else:
            state = {}
        metrics = collect(state, config['mounts'])
        now = metrics['timestamp']
        previous = state.get('metrics', {})
        reset = previous.get('boot_id') != metrics['boot_id'] or now - previous.get('timestamp', 0) > 180
        signals = assess(metrics, previous, config['limits'])
        records = state.setdefault('resources', {})
        for key, (severity, detail) in signals.items():
            records[key] = transition(records.get(key, {}), severity, detail, now,
                                      reset=reset, slow=key in ('cpu', 'load', 'swap'))
        state['metrics'] = metrics
        state['notification_status'] = notify_due(state, config, now, path)
        atomic_json(path, state)
        active = {key: r['level'] for key, r in records.items() if r['level']}
        summary = dict(metrics=metrics, alerts=active, notification_status=state['notification_status'])
        logger = logging.getLogger('metrics')
        logger.setLevel(logging.INFO)
        handler = logging.handlers.RotatingFileHandler(log_dir / 'metrics.jsonl', maxBytes=2 * MIB, backupCount=3)
        logger.addHandler(handler)
        logger.info(json.dumps(summary, ensure_ascii=False))
        logger.removeHandler(handler)
        handler.close()
        print(json.dumps(dict(alerts=active, notification_status=state['notification_status'],
                              cpu_pct=metrics['cpu_pct'], mem_available_mib=round(metrics['mem_available_bytes'] / MIB)),
                         ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--test-notification', action='store_true')
    parser.add_argument('--status', action='store_true')
    args = parser.parse_args()
    if args.status:
        s = json.loads((STATE / 'state.json').read_text())
        print(json.dumps(s, ensure_ascii=False, indent=2))
        return 0
    config = json.loads(CONFIG.read_text())
    if args.test_notification:
        try:
            destination = bridge_destination(config)
        except ValueError:
            destination = None
            result = 'invalid_bridge_config'
        else:
            result = 'not_configured'
        success = False
        if destination:
            success, result = send(destination, 'resource-monitor-test:' + uuid4().hex,
                                   socket.gethostname() + '：这是一条服务器资源监控测试通知。')
        print(json.dumps({'accepted_by_wechat': success, 'result': result}))
        return 0 if success else 2
    run(config)
    return 0


if __name__ == '__main__':
    os.umask(0o077)
    try:
        sys.exit(main())
    except Exception as error:
        print('monitor_failed: ' + type(error).__name__, file=sys.stderr)
        sys.exit(1)
