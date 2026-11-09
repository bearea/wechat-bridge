import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import monitor as m


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.metrics = {
            'timestamp': 1000, 'boot_id': 'boot1', 'cpu_pct': 10, 'cores': 1,
            'load5': 0.1, 'mem_available_bytes': 800 * m.MIB,
            'mem_total_bytes': 2000 * m.MIB, 'mem_available_pct': 40,
            'swap_used_pct': 50, 'oom_kills': 2,
            'disks': {'/': {'used_pct': 48, 'free_bytes': 15 * m.GIB, 'inode_used_pct': 12}},
        }
        self.config = {
            'limits': {'cpu_warning_pct': 85, 'cpu_critical_pct': 95},
            'reminder_seconds': 21600,
            'bridge': {'base_url': 'https://bridge.example.test/connect/', 'application_token': 'mock-only-token',
                       'user_id': 'test+operator'},
        }
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / 'state.json'

    def notify(self, state, now):
        status = m.notify_due(state, self.config, now, self.path)
        state['notification_status'] = status
        m.atomic_json(self.path, state)
        return status

    def state(self, **resources):
        return {'metrics': self.metrics, 'resources': {
            key: m.transition({}, 2, detail, 1000) for key, detail in resources.items()
        }}

    def assess(self, **changes):
        metrics = copy.deepcopy(self.metrics)
        metrics.update(changes)
        return m.assess(metrics, self.metrics, self.config['limits'])

    def test_healthy_baseline(self):
        self.assertTrue(all(v[0] == 0 for v in self.assess().values()))

    def test_low_available_memory_uses_available_not_free(self):
        self.assertEqual(self.assess(mem_available_pct=14)['memory'][0], 1)
        self.assertEqual(self.assess(mem_available_bytes=99 * m.MIB)['memory'][0], 2)

    def test_swap_alone_does_not_alarm(self):
        self.assertEqual(self.assess(swap_used_pct=99)['swap'][0], 0)
        self.assertEqual(self.assess(swap_used_pct=99, mem_available_pct=19)['swap'][0], 2)

    def test_disk_capacity_and_inode_shortages(self):
        for disk, metric, expected in [
            ({'used_pct': 85}, 'disk:/', 1),
            ({'free_bytes': 511 * m.MIB}, 'disk:/', 2),
            ({'inode_used_pct': 95}, 'inode:/', 2),
        ]:
            metrics = copy.deepcopy(self.metrics)
            metrics['disks']['/'].update(disk)
            self.assertEqual(m.assess(metrics, self.metrics, self.config['limits'])[metric][0], expected)

    def test_mount_read_failure_alerts(self):
        self.assertEqual(self.assess(disks={'/': {'unavailable': True}})['disk:/'][0], 2)

    def test_new_oom_and_reboot_baseline(self):
        self.assertEqual(self.assess(oom_kills=3)['oom'][0], 2)
        self.assertEqual(self.assess(oom_kills=3, boot_id='boot2')['oom'][0], 0)

    def test_warning_needs_three_consecutive_samples(self):
        r = {}
        for i in range(3):
            r = m.transition(r, 1, 'memory', i)
            self.assertEqual(r['level'], 1 if i == 2 else 0)

    def test_critical_memory_immediate_but_cpu_sustained(self):
        self.assertEqual(m.transition({}, 2, 'memory', 0)['level'], 2)
        self.assertEqual(m.transition({}, 2, 'cpu', 0, slow=True)['level'], 0)

    def test_recovery_and_gap_reset(self):
        r = m.transition({}, 2, 'memory', 0)
        r = m.transition(r, 0, 'ok', 60)
        self.assertEqual(r['level'], 2)
        r = m.transition(r, 0, 'ok', 120, reset=True)
        self.assertEqual(r['count'], 1)
        r = m.transition(r, 0, 'ok', 180)
        r = m.transition(r, 0, 'ok', 240)
        self.assertEqual(r['level'], 0)

    def test_healthy_upgrade_reports_configured_without_sending(self):
        state = self.state()
        state['notification_status'] = 'not_configured'
        with patch.object(m, 'send') as send:
            self.assertEqual(self.notify(state, 1000), 'configured')
            send.assert_not_called()

    def test_persists_the_exact_batch_before_send_and_reuses_it_after_restart(self):
        state = self.state(memory='low memory')

        def fail_after_record(destination, request_id, text):
            persisted = json.loads(self.path.read_text())['pending_notification']
            self.assertEqual((persisted['request_id'], persisted['text']), (request_id, text))
            return False, 'bridge_transport_error'

        with patch.object(m, 'send', side_effect=fail_after_record) as send:
            self.assertEqual(self.notify(state, 1000), 'bridge_transport_error')
            self.assertEqual(self.notify(state, 1030), 'bridge_transport_error')
            self.assertEqual(send.call_count, 1)
            original = send.call_args.args

        state = json.loads(self.path.read_text())
        state['metrics']['timestamp'] = 1060
        state['resources']['memory'].update(level=0, detail='recovered')
        self.assertEqual(state['resources']['memory']['notified_level'], 0)
        with patch.object(m, 'send', return_value=(True, 'accepted_by_wechat')) as send:
            self.assertEqual(self.notify(state, 1060), 'accepted_by_wechat')
            self.assertEqual(send.call_args.args, original)
            self.assertEqual(state['resources']['memory']['notified_level'], 2)
            self.assertNotIn('pending_notification', state)
            self.notify(state, 1120)
            self.assertIn('[恢复]', send.call_args.args[2])
            self.assertNotEqual(send.call_args.args[1], original[1])

    def test_alerts_are_grouped_and_recovery_sent_once(self):
        state = self.state(memory='low memory', **{'disk:/': 'full disk'})
        with patch.object(m, 'send', return_value=(True, 'accepted_by_wechat')) as send:
            self.notify(state, 1000)
            self.assertIn('low memory', send.call_args.args[2])
            self.assertIn('full disk', send.call_args.args[2])
            self.notify(state, 1120)
            self.assertEqual(send.call_count, 1)
            for record in state['resources'].values():
                record['level'] = 0
            self.notify(state, 1240)
            self.assertEqual(send.call_args.args[2].count('[恢复]'), 2)
            self.notify(state, 1360)
            self.assertEqual(send.call_count, 2)

    def test_sustained_alert_reminds_after_six_hours(self):
        state = self.state(memory='low memory')
        with patch.object(m, 'send', return_value=(True, 'accepted_by_wechat')) as send:
            self.notify(state, 1000)
            first_id = send.call_args.args[1]
            self.notify(state, 22599)
            self.assertEqual(send.call_count, 1)
            self.notify(state, 22600)
            self.assertEqual(send.call_count, 2)
            self.assertNotEqual(send.call_args.args[1], first_id)

    def test_unbound_and_interaction_required_keep_the_same_pending_batch(self):
        state = self.state(memory='low memory')
        results = [(False, 'binding_not_connected'), (False, 'interaction_required'), (True, 'accepted_by_wechat')]
        with patch.object(m, 'send', side_effect=results) as send:
            self.assertEqual(self.notify(state, 1000), 'binding_not_connected')
            self.assertEqual(self.notify(state, 1060), 'interaction_required')
            self.assertEqual(state['next_send_attempt'], 1180)
            self.assertEqual(state['resources']['memory']['notified_level'], 0)
            self.assertEqual(self.notify(state, 1180), 'accepted_by_wechat')
            self.assertEqual(send.call_count, 3)
            self.assertTrue(all(call.args == send.call_args_list[0].args for call in send.call_args_list))

    def test_uncertain_send_stays_unconfirmed_and_new_alerts_can_proceed(self):
        state = self.state(memory='low memory')
        with patch.object(m, 'send', side_effect=[
            (False, 'send_failed'), (False, 'previous_send_uncertain_or_failed'), (True, 'accepted_by_wechat'),
        ]) as send:
            self.assertEqual(self.notify(state, 1000), 'send_failed')
            self.assertEqual(self.notify(state, 1060), 'previous_send_uncertain_or_failed')
            self.assertEqual(send.call_args_list[0].args, send.call_args_list[1].args)
            self.assertEqual(state['resources']['memory']['notified_level'], 0)
            self.assertEqual(state['last_unconfirmed_notification']['request_id'], send.call_args.args[1])
            self.notify(state, 1120)
            self.assertEqual(send.call_count, 2)
            state['resources']['disk:/'] = m.transition({}, 2, 'full disk', 1180)
            self.assertEqual(self.notify(state, 1180), 'accepted_by_wechat')
            self.assertIn('full disk', send.call_args.args[2])
            self.assertNotIn('low memory', send.call_args.args[2])
            self.assertNotEqual(send.call_args_list[0].args[1], send.call_args.args[1])
            self.assertEqual(state['resources']['memory']['notified_level'], 0)

    def test_pending_id_is_never_reused_after_its_safe_retry_window(self):
        state = self.state(memory='low memory')
        with patch.object(m, 'send', return_value=(False, 'bridge_transport_error')) as send:
            self.notify(state, 1000)
            self.assertEqual(self.notify(state, 1000 + m.PENDING_MAX_AGE), 'pending_expired_review_required')
            self.assertEqual(send.call_count, 1)
            self.assertEqual(state['resources']['memory']['notified_level'], 0)

    def test_request_uses_bridge_prefix_bearer_token_and_stable_json(self):
        destination = m.bridge_destination(self.config)
        with patch.object(m.urllib.request, 'build_opener') as build:
            response = build.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = b'{"accepted_by_wechat":true,"delivery_confirmed":false,"duplicate":true}'
            self.assertEqual(m.send(destination, 'alert-1', 'low memory'), (True, 'accepted_by_wechat'))
            request = build.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, 'https://bridge.example.test/connect/v1/users/test%2Boperator/send')
            self.assertEqual(request.get_header('Authorization'), 'Bearer mock-only-token')
            self.assertEqual(request.get_method(), 'POST')
            self.assertEqual(json.loads(request.data), {'request_id': 'alert-1', 'text': 'low memory'})
            response.read.return_value = b'{"accepted_by_wechat":false}'
            self.assertEqual(m.send(destination, 'alert-1', 'low memory'), (False, 'bridge_invalid_response'))

    def test_http_rejection_and_transport_error_never_expose_raw_response(self):
        destination = m.bridge_destination(self.config)
        with patch.object(m.urllib.request, 'build_opener') as build:
            opener = build.return_value
            for raw, expected in [
                ('interaction_required', 'interaction_required'),
                ('mock-only-token', 'bridge_http_409'),
            ]:
                data = io.BytesIO(json.dumps({'error': raw}).encode())
                opener.open.side_effect = m.urllib.error.HTTPError(destination[0], 409, 'private error', {}, data)
                self.assertEqual(m.send(destination, 'alert-1', 'test'), (False, expected))
            opener.open.side_effect = TimeoutError('mock-only-token')
            self.assertEqual(m.send(destination, 'alert-1', 'test'), (False, 'bridge_transport_error'))

    def test_disallows_plaintext_remote_urls_and_does_not_forward_redirects(self):
        self.config['bridge']['base_url'] = 'http://bridge.example.test/connect/'
        with self.assertRaises(ValueError):
            m.bridge_destination(self.config)
        self.config['bridge']['base_url'] = 'http://127.0.0.1:8318/connect/'
        self.assertTrue(m.bridge_destination(self.config)[0].startswith('http://127.0.0.1:8318/'))
        self.assertIsNone(m.NoRedirect().redirect_request(None, None, 307, '', {}, 'https://example.test/'))

    def test_atomic_state_write(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            m.atomic_json(path, {'sample': 1})
            m.atomic_json(path, {'sample': 2})
            self.assertEqual(path.read_text(), '{"sample": 2}')
            self.assertFalse(path.with_suffix('.tmp').exists())


if __name__ == '__main__':
    unittest.main()
