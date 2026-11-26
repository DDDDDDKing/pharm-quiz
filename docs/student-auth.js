import {request} from './api.js?v=10';

function studentSession(initial) {
  let session = initial;
  let expiresAt = Date.now() + initial.expiresIn * 1000;
  let refreshing;
  return async () => {
    if (Date.now() < expiresAt - 60_000) return session.accessToken;
    if (!refreshing) {
      refreshing = request('auth', undefined, 'refresh', {refreshToken: session.refreshToken}).then(next => {
        session = next;
        expiresAt = Date.now() + next.expiresIn * 1000;
        return session.accessToken;
      }).finally(() => { refreshing = undefined; });
    }
    return refreshing;
  };
}

export function setupStudentAuth(onReady) {
  const $ = selector => document.querySelector(selector);
  const login = $('#student-form');
  const registration = $('#registration-form');
  const verification = $('#verification-form');
  const resend = $('#resend-code');
  const emailInput = $('#registration-email');
  const keyInput = $('#registration-key');
  const notice = $('#login-error');
  let view = 'login';
  let working = false;
  let pending;

  function message(text = '', error = true) {
    notice.textContent = text;
    notice.hidden = !text;
    notice.dataset.error = String(error);
  }

  function show(next, text = '') {
    view = next;
    login.hidden = next !== 'login';
    registration.hidden = !['register','legacy','recovery'].includes(next);
    verification.hidden = next !== 'verify';
    const recovery = next === 'recovery';
    const legacy = next === 'legacy';
    keyInput.setAttribute('inputmode', legacy ? 'text' : 'numeric');
    keyInput.maxLength = legacy ? 128 : 24;
    $('#registration-purchase').hidden = next !== 'register';
    keyInput.disabled = recovery;
    keyInput.hidden = recovery;
    $('#registration-key-label').hidden = recovery;
    $('#registration-hint').hidden = recovery;
    $('#registration-nickname-field').hidden = recovery;
    $('#registration-key-label').textContent = legacy ? '原刷题 ID' : '闲鱼订单编号';
    $('#registration-hint').textContent = next === 'legacy'
      ? '验证邮箱后可继续使用原有学习记录。'
      : '付款后，从闲鱼订单详情复制订单编号。注册通过后，管理员会复核订单。';
    if (registration.hidden && next !== 'verify') {
      registration.reset();
      verification.reset();
      pending = undefined;
    }
    message(text);
    const focus = next === 'login' ? $('#student-email') : next === 'verify' ? $('#verification-code') : emailInput;
    focus.focus();
  }

  async function run(button, action) {
    if (working) return;
    working = true;
    button.disabled = true;
    message();
    try {
      await action();
    } catch (error) {
      message(error.message);
    } finally {
      working = false;
      button.disabled = false;
    }
  }

  function bind(form, action) {
    form.addEventListener('submit', event => {
      event.preventDefault();
      void run(event.submitter || form.querySelector('[type="submit"]'), action);
    });
  }

  async function send(details) {
    const {email, recovery, legacy, key, nickname} = details;
    await request('auth', undefined, recovery ? 'start_recovery' : 'start_signup',
      recovery ? {email} : {email, legacy, key, nickname});
  }

  $('#login').addEventListener('click', event => {
    const next = event.target.closest('[data-auth-view]')?.dataset.authView;
    if (next && !working) {
      if (next !== 'login') {
        emailInput.value = $('#student-email').value;
        keyInput.value = '';
      } else if (pending) {
        $('#student-email').value = pending.email;
      }
      show(next);
    }
  });

  bind(login, async () => {
    const email = $('#student-email').value;
    const password = $('#student-password').value;
    $('#student-password').value = '';
    const result = await request('auth', undefined, 'sign_in', {email, password});
    await onReady(studentSession(result));
  });

  bind(registration, async () => {
    const details = {email:emailInput.value.trim(), recovery:view === 'recovery', legacy:view === 'legacy',
      key:keyInput.value, nickname:$('#registration-nickname').value};
    await send(details);
    pending = details;
    $('#verification-note').textContent = '请输入发到 ' + details.email + ' 的验证码。';
    $('#verification-submit').textContent = details.recovery ? '验证并重置密码' : '验证并激活账号';
    show('verify');
  });

  bind(verification, async () => {
    const {email, recovery, legacy, key} = pending;
    if (!pending.session) {
      const result = await request('auth', undefined, recovery ? 'verify_recovery' : 'verify_signup', {
        email, code:$('#verification-code').value, password:$('#verification-password').value
      });
      pending.session = studentSession(result);
    }
    await onReady(pending.session, legacy ? key : undefined);
    verification.reset();
    registration.reset();
    pending = undefined;
  });

  resend.addEventListener('click', () => {
    if (!pending) return;
    void run(resend, async () => {
      await send(pending);
      message('验证码已重新发送。', false);
    });
  });

  return {showLogin: text => show('login', text)};
}
