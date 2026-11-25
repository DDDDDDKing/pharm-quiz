const endpoint = 'https://qjnqnchqqbuzjvlkytjl.supabase.co/functions/v1/pharm-quiz';
const publishableKey = 'sb_publishable_aIMDQatzimHuYaBz9v9E0Q_0ILIq4k4';

// Older page modules can still be open during a Pages deployment.
export function normalizeId(value) {
  return value.trim().toUpperCase();
}

export function isValidId(value) {
  return value.length <= 128 && value.trim().length > 0 && !/[\r\n\0]/.test(value);
}

export async function request(role, credential, action, details = {}) {
  let response;
  let data;
  const body = JSON.stringify({role, credential, action, ...details});
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {'Content-Type':'application/json', apikey:publishableKey},
      body,
      keepalive: role === 'student' && action === 'sync' && new Blob([body]).size < 60_000,
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(action === "explain" ? 65_000 : 20_000)
    });
    data = await response.json();
  } catch {
    throw new Error('连接失败，请检查网络后重试。');
  }
  if (!response.ok) {
    const denied = data.error === 'access_denied';
    const message = denied ? 'ID 无效、未开通或已停用。'
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
