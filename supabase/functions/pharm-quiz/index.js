const supabaseUrl = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const allowedOrigins = new Set(['https://ddddddking.github.io']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const questionId = /^[1-9]-[0-9]{1,3}$/;
const allowedModes = new Set(['seq', 'random', 'wrong', 'fav', 'exam', 'search', 'single', 'review']);
const maxBody = 512_000;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isValidId = value => typeof value === 'string' && value.length <= 128
  && value.trim().length > 0 && value.isWellFormed() && !/[\r\n\0]/.test(value);
const isInt = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const isSection = value => /^s[0-8]$/.test(value);
const isSelection = value => Array.isArray(value) && value.length > 0 && value.length <= 6
  && value.every((letter, i) => /^[A-F]$/.test(letter) && (i === 0 || letter > value[i - 1]));

function validResume(value) {
  return isObject(value) && typeof value.title === 'string' && value.title.length <= 100
    && Array.isArray(value.ids) && value.ids.length > 0 && value.ids.length <= 1709
    && value.ids.every(id => typeof id === 'string' && questionId.test(id))
    && isInt(value.i, value.ids.length - 1) && allowedModes.has(value.mode)
    && (value.key === null || isSection(value.key));
}

function validExam(draft) {
  if (draft === null) return true;
  if (!isObject(draft) || !Array.isArray(draft.ids) || draft.ids.length !== 50
      || !draft.ids.every(id => typeof id === 'string' && questionId.test(id))
      || new Set(draft.ids).size !== 50 || !isInt(draft.i, 49) || !isInt(draft.t0, 4_102_444_800_000)
      || !isObject(draft.pick)) return false;
  return Object.entries(draft.pick).every(([id, selection]) => draft.ids.includes(id)
    && Array.isArray(selection) && (selection.length === 0 || isSelection(selection)));
}

function validPatch(patch) {
  if (!isObject(patch)) return false;
  return Object.entries(patch).every(([key, value]) => {
    if (key === 'exam') return validExam(value);
    if (key === 'theme') return value === 'light' || value === 'dark';
    if (key === 'autonext') return typeof value === 'boolean';
    if (key === 'fav' || key === 'wrong') {
      return isObject(value) && Object.entries(value).length <= 1709
        && Object.entries(value).every(([id, enabled]) => questionId.test(id) && typeof enabled === 'boolean');
    }
    if (key === 'pos') {
      return isObject(value) && Object.entries(value).every(([id, position]) =>
        id === '__last' ? validResume(position) : isSection(id) && isInt(position, 1708));
    }
    return false;
  });
}

function validEvent(event) {
  if (!isObject(event) || typeof event.id !== 'string' || !uuid.test(event.id)) return false;
  if (event.reset === true) return Object.keys(event).every(k => k === 'id' || k === 'reset');
  return Array.isArray(event.attempts) && event.attempts.length <= 1709
    && event.attempts.every(attempt => isObject(attempt) && typeof attempt.question === 'string'
      && questionId.test(attempt.question) && typeof attempt.day === 'string' && /^20[0-9]{2}-[01][0-9]-[0-3][0-9]$/.test(attempt.day)
      && isInt(attempt.time, 4_102_444_800_000) && isSelection(attempt.selection))
    && validPatch(event.patch);
}

Deno.serve(async req => {
  const origin = req.headers.get('origin');
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
  if (origin && allowedOrigins.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'content-type, apikey';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }
  const reply = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers });
  if (origin && !allowedOrigins.has(origin)) return reply({error:'origin_denied'}, 403);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return reply({error:'method_not_allowed'}, 405);
  if (!supabaseUrl || !serviceKey) return reply({error:'service_unavailable'}, 503);
  if (Number(req.headers.get('content-length')) > maxBody) return reply({error:'payload_too_large'}, 413);

  let input;
  try {
    const body = await req.text();
    if (body.length > maxBody) return reply({error:'payload_too_large'}, 413);
    input = JSON.parse(body);
  } catch {
    return reply({error:'invalid_request'}, 400);
  }
  if (!isObject(input)) return reply({error:'invalid_request'}, 400);
  const { role, action, credential } = input;
  if ((role !== 'student' && role !== 'admin') || !isValidId(credential)) return reply({error:'access_denied'}, 403);

  let body = {};
  if (role === 'student') {
    if (action === 'sync' && isInt(input.epoch, 2_147_483_647) && isInt(input.revision, Number.MAX_SAFE_INTEGER)
        && Array.isArray(input.events) && input.events.length <= 25 && input.events.every(validEvent)) {
      body = {epoch:input.epoch, revision:input.revision, events:input.events};
    } else if (action !== 'login') {
      return reply({error:'invalid_request'}, 400);
    }
  } else if (action === 'add' && isValidId(input.studentId) && typeof input.label === 'string'
      && input.label.length <= 80 && input.label.isWellFormed() && !input.label.includes('\0')) {
    body = {student_id:input.studentId, label:input.label.trim() || '学员'};
  } else if (action === 'set_active' && typeof input.account === 'string' && uuid.test(input.account) && typeof input.active === 'boolean') {
    body = {account:input.account, active:input.active};
  } else if (action !== 'list') {
    return reply({error:'invalid_request'}, 400);
  }

  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(credential));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
    const upstream = await fetch(`${supabaseUrl}/rest/v1/rpc/pharm_quiz_${role}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`
      },
      body: JSON.stringify({p_hash:hash, p_action:action, p_body:body}),
      signal: AbortSignal.timeout(15_000)
    });
    if (!upstream.ok) {
      const { code } = await upstream.json().catch(() => ({}));
      console.error('Pharmacology database request failed', role, action, upstream.status, code);
      return reply({error:'service_unavailable'}, 503);
    }
    const result = await upstream.json();
    if (result.error) {
      const status = {access_denied:403, id_in_use:409, invalid_request:400};
      return reply(result, status[result.error] || 404);
    }
    return reply(result);
  } catch (error) {
    console.error('Pharmacology request failed', role, action, error?.name);
    return reply({error:'service_unavailable'}, 503);
  }
});
