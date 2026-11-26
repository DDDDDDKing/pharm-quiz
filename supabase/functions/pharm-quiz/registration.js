const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const otpPattern = /^[0-9]{6}$/;
const endOfLine = /[\r\n\0]/;
const adminName = /^[a-z0-9_.-]{1,40}$/;
const encoder = new TextEncoder();

export function validLegacyId(value) {
  return typeof value === 'string' && value.length <= 128 && value.trim().length > 0
    && value.isWellFormed() && !endOfLine.test(value);
}

export async function hashCredential(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function databaseCall(url, key, fn, data) {
  const response = await fetch(url + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key},
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) {
    const {code} = await response.json().catch(() => ({}));
    console.error('Pharmacology database request failed', fn, response.status, code);
    throw new Error('Database request failed');
  }
  return response.json();
}

export async function authCall(url, key, path, body, token, method = 'POST') {
  const headers = {'Content-Type': 'application/json', apikey: key};
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(url + '/auth/v1/' + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12_000)
  });
  return {...(await response.json().catch(() => ({}))), ok: response.ok, status: response.status};
}

function emailAddress(value) {
  if (typeof value !== 'string' || value.length > 254 || !value.isWellFormed()) return null;
  const email = value.trim().toLowerCase();
  return emailPattern.test(email) && !endOfLine.test(email) ? email : null;
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 72
    && value.isWellFormed() && !value.includes('\0') && encoder.encode(value).length <= 72;
}

export function normalizeOrder(value, lengths) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const number = value.trim();
  return /^[0-9]+$/.test(number) && lengths.has(number.length) ? number : null;
}

function replyWithSession(result, reply) {
  if (!result.access_token || !result.refresh_token) return reply({error: 'service_unavailable'}, 503);
  return reply({accessToken: result.access_token, refreshToken: result.refresh_token,
    expiresIn: result.expires_in});
}

export function registrationReply(result, reply) {
  const statuses = {
    already_registered: 409, email_reserved: 409, key_reserved: 409, email_rate_limit: 429,
    invalid_order: 400, order_in_use: 409, invalid_legacy_id: 400, already_reviewed: 409, registration_required: 409, access_denied: 403
  };
  return reply({error: result.error}, statuses[result.error] || 400);
}

export async function handleRegistration(input, runAuth, rpc, reply, orderLengths) {
  const email = emailAddress(input.email);
  const invalid = () => reply({error: 'invalid_request'}, 400);
  const mailError = result => {
    if (result.status === 429) return reply({error: 'email_rate_limit'}, 429);
    console.error('Pharmacology Auth email failed', input.action, result.status, result.error_code);
    return reply({error: 'email_send_failed'}, 502);
  };

  switch (input.action) {
    case 'start_signup': {
      if (!email || typeof input.legacy !== 'boolean' || typeof input.nickname !== 'string'
        || input.nickname.length > 40 || !input.nickname.isWellFormed() || endOfLine.test(input.nickname)) return invalid();
      const order = input.legacy ? null : normalizeOrder(input.key, orderLengths);
      if (input.legacy ? !validLegacyId(input.key) : !order) {
        return reply({error: input.legacy ? 'invalid_legacy_id' : 'invalid_order'}, 400);
      }
      const source = input.legacy ? input.key : 'xianyu-order:' + order;
      const reservation = await rpc('pharm_quiz_reserve_signup', {
        p_email: email, p_hash: await hashCredential(source), p_legacy: input.legacy,
        p_nickname: input.nickname.trim(), p_order: order
      });
      if (reservation.error) return registrationReply(reservation, reply);
      // The user sets the password with a verified session, never in the pending signup request.
      const result = await runAuth('signup', {email, password: crypto.randomUUID() + 'aA1!',
        data: {pharm_signup_ticket: reservation.ticket}});
      if (!result.ok) return mailError(result);
      if (result.access_token || result.email_confirmed_at) {
        console.error('Pharmacology Auth signup unexpectedly auto-confirmed an account');
        return reply({error: 'email_send_failed'}, 502);
      }
      return reply({ok: true});
    }
    case 'verify_signup':
    case 'verify_recovery': {
      if (!email || typeof input.code !== 'string' || !otpPattern.test(input.code)
        || !validPassword(input.password)) return invalid();
      const result = await runAuth('verify', {email, token: input.code,
        type: input.action === 'verify_signup' ? 'signup' : 'recovery'});
      if (!result.ok || !result.access_token) {
        return result.status === 429 ? reply({error: 'email_rate_limit'}, 429)
          : reply({error: 'otp_invalid'}, 400);
      }
      const updated = await runAuth('user', {password: input.password}, result.access_token, 'PUT');
      if (!updated.ok) {
        if (updated.error_code === 'same_password') return replyWithSession(result, reply);
        console.error('Pharmacology Auth password update failed', updated.status, updated.error_code);
        return reply({error: 'password_update_failed'}, 409);
      }
      return replyWithSession(result, reply);
    }
    case 'sign_in': {
      if (!email || !validPassword(input.password)) return invalid();
      const result = await runAuth('token?grant_type=password', {email, password: input.password});
      if (result.status === 429) return reply({error: 'auth_rate_limit'}, 429);
      if (!result.ok) return reply({error: 'invalid_login'}, 401);
      return replyWithSession(result, reply);
    }
    case 'refresh': {
      if (typeof input.refreshToken !== 'string' || input.refreshToken.length > 512) return invalid();
      const result = await runAuth('token?grant_type=refresh_token', {refresh_token: input.refreshToken});
      if (!result.ok) return result.status >= 500 ? reply({error: 'service_unavailable'}, 503)
        : reply({error: 'access_denied'}, 403);
      return replyWithSession(result, reply);
    }
    case 'admin_sign_in': {
      const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
      if (!adminName.test(username) || !validPassword(input.password)) {
        return reply({error: 'invalid_admin_login'}, 401);
      }
      const result = await rpc('pharm_quiz_admin_sign_in', {p_username: username, p_password: input.password});
      if (result.error) return reply(result, result.error === 'auth_rate_limit' ? 429 : 401);
      return reply(result);
    }
    case 'start_recovery': {
      if (!email) return invalid();
      const result = await runAuth('recover', {email});
      if (!result.ok) return mailError(result);
      return reply({ok: true});
    }
    default:
      return invalid();
  }
}
