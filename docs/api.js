const endpoint = 'https://qjnqnchqqbuzjvlkytjl.supabase.co/functions/v1/pharm-quiz';
const publishableKey = 'sb_publishable_aIMDQatzimHuYaBz9v9E0Q_0ILIq4k4';

export function normalizeId(value) {
  return value.trim().toUpperCase();
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
      signal: AbortSignal.timeout(20_000)
    });
    data = await response.json();
  } catch {
    throw new Error('连接失败，请检查网络后重试。');
  }
  if (!response.ok) {
    const denied = data.error === 'access_denied';
    const error = new Error(denied ? 'ID 无效、未开通或已停用。' : '服务器暂未完成请求，请重试。');
    error.denied = denied;
    throw error;
  }
  return data;
}

window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});
