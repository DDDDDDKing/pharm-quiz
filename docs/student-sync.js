import { request } from './api.js?v=4';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode64(data) {
  let value = '';
  for (const byte of data) value += String.fromCharCode(byte);
  return btoa(value);
}

function decode64(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

export function emptyProgress() {
  return {rec:{}, fav:[], wrong:[], pos:{}, hist:{}, autonext:false, theme:'light', exam:null, notes:{}, marked:{}, mastered:{}};
}

export function applyEvent(state, event, isCorrect) {
  for (const attempt of event.attempts) {
    const {question, time, day, selection} = attempt;
    const ok = Number(isCorrect(question, selection));
    const counter = state.rec[question] || {a:0,c:0};
    state.rec[question] = {a:counter.a+1, c:counter.c+ok, w:1-ok, t:time, sel:selection};
    const daily = state.hist[day] || {n:0,ok:0};
    state.hist[day] = {n:daily.n+1, ok:daily.ok+ok};
  }
  for (const list of ['fav','wrong']) {
    const items = new Set(state[list]);
    for (const [id, enabled] of Object.entries(event.patch[list] || {})) {
      if (enabled) items.add(id);
      else items.delete(id);
    }
    state[list] = [...items];
  }
  Object.assign(state.pos, event.patch.pos);
  for (const key of ['notes','marked','mastered']) Object.assign(state[key],event.patch[key]);
  for (const key of ['autonext','theme','exam']) {
    if (Object.hasOwn(event.patch, key)) state[key] = event.patch[key];
  }
}

export async function connectProgress(credential, login, callbacks) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode('pharm-outbox:' + credential));
  const name = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2,'0')).join('');
  const keyMaterial = await crypto.subtle.digest('SHA-256', encoder.encode('pharm-encryption:' + credential));
  const key = await crypto.subtle.importKey('raw', keyMaterial, 'AES-GCM', false, ['encrypt','decrypt']);
  const prefix = 'pharm.pending.' + name + '.';
  const pending = new Map();
  let epoch = login.epoch;
  let revision = login.revision;
  let baseline = {...emptyProgress(), ...login.state};
  let timer;
  let inFlight;
  let stopped = false;
  let diskError = false;
  let resetNotice = false;

  function remove(id) {
    pending.delete(id);
    try { localStorage.removeItem(prefix + id); } catch {}
  }

  async function persist(item) {
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const bytes = await crypto.subtle.encrypt({name:'AES-GCM',iv}, key, encoder.encode(JSON.stringify(item)));
      if (pending.has(item.event.id)) {
        localStorage.setItem(prefix + item.event.id, encode64(iv) + '.' + encode64(new Uint8Array(bytes)));
      }
    } catch {
      if (pending.has(item.event.id)) diskError = true;
    }
  }

  async function recover() {
    try {
      const keys = Object.keys(localStorage).filter(id => id.startsWith(prefix));
      for (const id of keys) {
        const stored = localStorage.getItem(id);
        if (!stored) continue;
        const [iv, bytes] = stored.split('.');
        try {
          const plain = await crypto.subtle.decrypt({name:'AES-GCM',iv:decode64(iv)}, key, decode64(bytes));
          const item = JSON.parse(decoder.decode(plain));
          if (item.epoch === epoch) pending.set(item.event.id, item);
          else { remove(item.event.id); resetNotice = true; }
        } catch { diskError = true; }
      }
    } catch { diskError = true; }
  }

  const ordered = () => [...pending.values()].sort((a,b) => a.at - b.at);
  function snapshot() {
    const data = structuredClone(baseline);
    for (const item of ordered()) applyEvent(data, item.event, callbacks.isCorrect);
    return data;
  }

  function emitStatus(text, error = false) {
    if (!stopped) callbacks.status(text, error);
  }

  function schedule(ms) {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => { void flush(); }, ms);
  }

  function update(result, expectedReset = false, reconciled = false) {
    const changed = revision !== result.revision;
    const reset = epoch !== result.epoch;
    if (reset) {
      if (pending.size && !expectedReset) resetNotice = true;
      for (const id of pending.keys()) remove(id);
    }
    epoch = result.epoch;
    revision = result.revision;
    if (result.state) baseline = {...emptyProgress(), ...result.state};
    if (changed || reset || reconciled) callbacks.update(snapshot(), reset);
  }

  async function flush() {
    if (stopped) return false;
    if (inFlight) return inFlight;
    clearTimeout(timer);
    inFlight = (async () => {
      // An exam is a single operation. Keep each HTTP request bounded.
      const batch = [];
      let bytes = 0;
      for (const {event} of ordered().slice(0, 25)) {
        bytes += JSON.stringify(event).length;
        if (batch.length && bytes > 100_000) break;
        batch.push(event);
      }
      if (batch.length) emitStatus('同步中…');
      try {
        const result = await request('student', credential, 'sync', {epoch, revision, events:batch});
        if (stopped) return false;
        if (result.epoch === epoch) for (const event of batch) remove(event.id);
        update(result, false, batch.length > 0);
        if (!pending.size) {
          diskError = false;
          emitStatus(resetNotice ? '已载入云端重置后的进度' : '已同步');
        }
        schedule(pending.size ? 15 : 30_000);
        return true;
      } catch (error) {
        if (stopped) return false;
        if (error.denied) callbacks.denied(error.message);
        else {
          emitStatus(pending.size
            ? (diskError ? '待同步，请保留此页面' : '已暂存，恢复连接后同步')
            : '未连接 · 点此重试', true);
          schedule(8_000);
        }
        return false;
      }
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  await recover();
  return {
    snapshot,
    start() { schedule(pending.size ? 0 : 30_000); },
    enqueue(attempts, patch) {
      if (!attempts.length && !Object.keys(patch).length) return;
      const event = {id:crypto.randomUUID(), attempts, patch};
      const item = {epoch, at:Date.now(), event};
      pending.set(event.id, item);
      void persist(item);
      emitStatus('等待同步…');
      schedule(180);
    },
    flush,
    explain(question) { return request('student',credential,'explain',{question}); },
    async clear() {
      while (inFlight || pending.size) {
        if (!await flush()) throw new Error('请联网并同步现有进度后再清空。');
      }
      clearTimeout(timer);
      inFlight = (async () => {
        try {
          const result = await request('student', credential, 'sync', {
            epoch, revision, events:[{id:crypto.randomUUID(), reset:true}]
          });
          if (!stopped) {
            resetNotice = false;
            update(result, true);
            emitStatus('已同步');
          }
          return true;
        } catch (error) {
          if (error.denied) callbacks.denied(error.message);
          else emitStatus('清空请求未确认 · 点此重试', true);
          return false;
        }
      })().finally(() => { inFlight = null; });
      const cleared = await inFlight;
      schedule(30_000);
      if (!cleared) throw new Error('云端未确认清空，请同步后检查记录。');
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    }
  };
}
