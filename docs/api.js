const endpoint = 'https://qjnqnchqqbuzjvlkytjl.supabase.co/functions/v1/pharm-quiz';
const publishableKey = 'sb_publishable_aIMDQatzimHuYaBz9v9E0Q_0ILIq4k4';

// Older page modules can still be open during a Pages deployment.
export function normalizeId(value) {
  return value.trim().toUpperCase();
}

export const AI_UPGRADE_CREDITS = 100;

export function isValidId(value) {
  return value.length <= 128 && value.trim().length > 0 && !/[\r\n\0]/.test(value);
}

export async function request(role, credential, action, details = {}) {
  let response;
  let data;
  const token = typeof credential === 'function' ? await credential() : credential;
  const body = JSON.stringify({role, credential:token, action, ...details});
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {'Content-Type':'application/json', apikey:publishableKey},
      body,
      keepalive: role === 'student' && action === 'sync' && new Blob([body]).size < 60_000,
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(action === 'explain' ? 65_000 : role === 'auth' ? 30_000 : 20_000)
    });
    data = await response.json();
  } catch {
    throw new Error('连接失败，请检查网络后重试。');
  }
  if (!response.ok) {
    const denied = data.error === 'access_denied';
    const message = denied ? (role === 'admin' ? '管理会话已过期，请重新登录。' : '登录已过期或账号已停用，请重新登录。')
      : data.error === 'invalid_request' && role === 'auth' ? '请检查邮箱、验证码或密码是否符合要求。密码至少 8 个字符。'
      : data.error === 'invalid_order' ? '请粘贴闲鱼订单详情里的完整数字编号。'
      : data.error === 'order_in_use' ? '这个订单编号已提交，请核对后重试。'
      : data.error === 'already_reviewed' ? '这笔订单已处理，请刷新列表。'
      : data.error === 'invalid_admin_login' ? '管理员用户名或密码错误。'
      : data.error === 'invalid_legacy_id' ? '这个旧刷题 ID 无效、已绑定或已停用。'
      : data.error === 'already_registered' ? '这个邮箱已注册，请直接登录或重置密码。'
      : data.error === 'email_reserved' || data.error === 'key_reserved' ? '正在验证另一笔注册。请用原邮箱和订单编号继续，或等本次验证过期。'
      : data.error === 'email_rate_limit' || data.error === 'auth_rate_limit' ? '尝试过于频繁，请稍后重试。'
      : data.error === 'email_send_failed' ? '验证码未发出，请稍后重试。'
      : data.error === 'otp_invalid' ? '验证码错误或已过期，请重新发送。'
      : data.error === 'password_update_failed' ? '邮箱已验证，但密码未能保存，请用“忘记密码”重新设置。'
      : data.error === 'invalid_login' ? '登录失败，请检查邮箱和密码，或完成邮箱验证。'
      : data.error === 'registration_required' ? '账号尚未激活。请先用闲鱼订单编号或旧 ID 开通。'
      : data.error === 'id_in_use' ? '这个 ID 已被使用，请填写另一个。'
      : data.error === 'ai_not_configured' ? '管理员尚未启用 AI 解析，请联系管理员在后台配置模型 API。'
      : data.error === 'ai_limit' ? '今日免费额度和升级余额均已用完。'
      : data.error === 'ai_quota_update' ? '额度未更新，请刷新后确认学员和余额。'
      : data.error === 'ai_provider_error' ? '模型服务未返回解析，请管理员检查密钥、模型 ID 和剩余额度。'
      : '服务器暂未完成请求，请重试。';
    const error = new Error(message);
    error.denied = denied;
    error.code = data.error;
    throw error;
  }
  return data;
}

window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});
