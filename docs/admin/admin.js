import {normalizeId, request} from '../api.js';

const $ = selector => document.querySelector(selector);
const seenFormat = new Intl.DateTimeFormat('zh-CN', {
  month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
});
let credential;
let busy = false;
let session = 0;

function feedback(text, error = false) {
  $('#feedback').textContent = text;
  $('#feedback').dataset.error = String(error);
}

function render(students) {
  $('#empty-list').hidden = students.length > 0;
  $('#table-wrap').hidden = students.length === 0;
  $('#student-count').textContent = students.length ? '（' + students.length + '）' : '';
  const rows = students.map(student => {
    const row = document.createElement('tr');
    const accuracy = student.attempts ? Math.round(student.correct * 100 / student.attempts) + '%' : '—';
    const values = [
      student.label, student.active ? '已启用' : '已停用', student.distinct_questions,
      student.attempts, accuracy, student.wrong, student.last_seen ? seenFormat.format(new Date(student.last_seen)) : '尚未登录'
    ];
    for (const value of values) row.insertCell().textContent = String(value);
    const label = document.createElement('small');
    label.textContent = 'ID 尾号 ' + student.hint;
    row.cells[0].append(document.createElement('br'),label);

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = student.active ? '停用' : '恢复';
    button.setAttribute('aria-label', button.textContent + ' ' + student.label);
    button.addEventListener('click', () => run(button, async (id, current) => {
      await request('admin', id, 'set_active', {account:student.id, active:!student.active});
      const result = await request('admin', id, 'list');
      if (current !== session) return;
      render(result.students);
      feedback(student.active ? '该 ID 已停用。' : '该 ID 已恢复。');
    }));
    row.insertCell().append(button);
    return row;
  });
  $('#roster').replaceChildren(...rows);
}

function signOut(message = '') {
  session++;
  credential = null;
  busy = false;
  $('#dashboard').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = message;
  $('#student-label').value = '';
  $('#issued-id').value = '';
  $('#issued').hidden = true;
  feedback('');
  render([]);
  $('#admin-id').focus();
}

async function run(button, action) {
  if (!credential || busy) return;
  busy = true;
  const current = session;
  button.disabled = true;
  feedback('');
  try {
    await action(credential, current);
  } catch (error) {
    if (session === current) {
      if (error.denied) signOut(error.message);
      else feedback(error.message, true);
    }
  } finally {
    if (session === current) busy = false;
    button.disabled = false;
  }
}

$('#admin-form').addEventListener('submit', async event => {
  event.preventDefault();
  const key = normalizeId($('#admin-id').value);
  const button = event.currentTarget.querySelector('button[type="submit"]');
  $('#login-error').textContent = '';
  if (!/^PA-[0-9A-F]{32}$/.test(key)) {
    $('#login-error').textContent = '请输入完整的管理员 ID。';
    return;
  }
  button.disabled = true;
  button.textContent = '正在登录…';
  try {
    const result = await request('admin', key, 'list');
    session++;
    credential = key;
    $('#admin-id').value = '';
    render(result.students);
    $('#login').hidden = true;
    $('#dashboard').hidden = false;
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = '登录管理端';
  }
});

$('#add-form').addEventListener('submit', event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const label = $('#student-label').value.trim();
  if (!label) { feedback('请输入姓名或备注。', true); return; }
  void run(button, async (id, current) => {
    const issued = await request('admin', id, 'add', {label});
    if (session !== current) return;
    $('#student-label').value = '';
    $('#issued-id').value = issued.credential;
    $('#issued').hidden = false;
    const result = await request('admin', id, 'list');
    if (session !== current) return;
    render(result.students);
    feedback('已开通该刷题 ID。');
  });
});

$('#reload').addEventListener('click', event => {
  void run(event.currentTarget, async (id, current) => {
    const result = await request('admin', id, 'list');
    if (session === current) {
      render(result.students);
      feedback('学习进度已更新。');
    }
  });
});
$('#copy-id').addEventListener('click', async () => {
  const input = $('#issued-id');
  try {
    await navigator.clipboard.writeText(input.value);
    feedback('已复制。');
  } catch {
    input.select();
    feedback('完整 ID 已选中，可以手动复制。');
  }
});
$('#sign-out').addEventListener('click', () => signOut());
