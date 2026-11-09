const $ = id => document.getElementById(id);
const errors = { session_required: '请使用服务提供的专属绑定链接打开此页。', invitation_expired_or_used: '绑定链接已使用或已过期，请重新获取。', receipt_not_matched: '回执码未匹配，请检查微信收到的六位数字。', rate_limited: '操作较频繁，请稍后重试。', service_unavailable: '服务暂不可用，请稍后重试。', invalid_request: '请检查输入内容。', no_verification_pending: '当前无需提交配对码。' };
const api = async (path, data) => {
  const response = await fetch('api/' + path, { method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', headers: data === undefined ? {} : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(errors[result.error] || '操作未完成，请刷新状态后重试。');
  return result;
};
let qrShown = false, authorized = false;
const show = (id, visible) => { $(id).hidden = !visible; };
function render(data) {
  const binding = data.binding, login = data.login;
  let title = '尚未连接微信', detail = '点击下方按钮，生成微信官方授权二维码。';
  const starting = login?.state === 'starting';
  if (starting) { title = '正在生成二维码'; detail = '请稍候，或取消本次绑定。'; }
  const qrActive = login && ['wait', 'scaned', 'need_verifycode'].includes(login.state);
  if (qrActive) { title = login.state === 'wait' ? '等待微信扫码' : '等待确认授权'; detail = '请使用你要绑定的微信扫码，并按手机页面提示确认。'; }
  if (login?.state === 'expired') { title = '二维码已过期'; detail = '请重新生成二维码。'; }
  if (['provider_error','verify_code_blocked','already_bound_elsewhere','rebind_required'].includes(login?.state)) {
    title = '本次绑定未完成'; detail = login.state === 'already_bound_elsewhere' ? '这个微信已关联其他应用账号。请先解除原连接，或使用另一个微信。' : '微信未完成授权。请重新生成二维码并按手机提示操作。';
  }
  if (binding && !starting && !qrActive) {
    title = binding.state === 'verified' ? '微信通道已验证' : binding.state === 'confirm_receipt' ? '请确认微信回执' : '微信授权完成，等待收发验证';
    detail = binding.state === 'verified' ? '已验证双向收发。当前为通道测试模式，聊天服务尚未接入。' : '请在微信 ClawBot 对话里发送“测试”，再把收到的六位回执码填到下方。';
    if (binding.error) {
      title = binding.error === 'rebind_required' ? '微信连接需要重新绑定' : '微信通道暂未完成收发';
      detail = binding.error === 'interaction_required' ? '请在微信 ClawBot 里主动发一条消息，以更新会话。' : binding.error === 'send_failed' ? '已收到消息，但微信回复发送未确认。请稍后在微信里再发一次“测试”。' : binding.error === 'rebind_required' ? '授权已失效，请重新扫码。' : '网络正在重试，请稍候。';
    }
  }
  $('status').textContent = title; $('detail').textContent = detail;
  $('dot').classList.toggle('connected', binding?.state === 'verified' && !binding.error);
  show('bind', !starting && !qrActive && (!binding || binding.error === 'rebind_required'));
  show('qr-box', qrActive); show('provider-code', login?.state === 'need_verifycode');
  show('receipt-box', binding && binding.state !== 'verified' && binding.last_inbound);
  show('unbind', Boolean(binding || starting || qrActive));
  $('unbind').textContent = binding ? '解除本服务连接' : '取消本次绑定';
  if (qrActive && !qrShown) { $('qr').src = 'api/qr.png?t=' + Date.now(); qrShown = true; }
  if (!qrActive) qrShown = false;
}
async function refresh() {
  try { const status = await api('status'); authorized = true; render(status); }
  catch (error) { $('error').textContent = error.message; if (!authorized) { $('status').textContent = '需要专属绑定链接'; $('detail').textContent = '绑定链接用于确认这个微信属于哪个应用账号。'; } }
}
async function action(button, callback) {
  $(button).disabled = true; $('error').textContent = '';
  try { await callback(); await refresh(); } catch (error) { $('error').textContent = error.message; }
  finally { $(button).disabled = false; }
}
$('bind').onclick = () => action('bind', async () => { qrShown = false; render(await api('bind', {})); });
$('submit-provider').onclick = () => action('submit-provider', () => api('verify-code', { code: $('provider-input').value.trim() }));
$('confirm').onclick = () => action('confirm', () => api('confirm-receipt', { code: $('receipt').value.trim() }));
$('unbind').onclick = () => { if (window.confirm($('unbind').textContent + '？')) action('unbind', () => api('unbind', {})); };
(async () => {
  const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (invite) {
    history.replaceState(null, '', location.pathname);
    try { await api('session', { invite }); } catch (error) { $('error').textContent = error.message; }
  }
  await refresh(); setInterval(() => { if (!document.hidden && authorized) refresh(); }, 2500);
})();
