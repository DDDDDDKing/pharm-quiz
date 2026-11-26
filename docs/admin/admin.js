import {AI_UPGRADE_CREDITS, isValidId, request} from '../api.js?v=7';

const $ = selector => document.querySelector(selector);
const seenFormat = new Intl.DateTimeFormat('zh-CN', {
  month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hourCycle:'h23'
});
let credential;
let busy = false;
let session = 0;
let detail;
let quotaAccount;

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
    label.textContent = student.hint ? '登录 ID 尾号 ' + student.hint : '登录 ID 已设置';
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
    const inspect=document.createElement('button');
    inspect.type='button';inspect.textContent='查看作答与评论';
    inspect.addEventListener('click',()=>run(inspect,async(id,current)=>{
      const data=await request('admin',id,'detail',{account:student.id});
      if(current!==session)return;
      detail=data;$('#student-detail').hidden=false;$('#detail-title').textContent=data.label+' · 作答与评论';
      renderDetail();$('#student-detail').scrollIntoView({behavior:'smooth',block:'start'});
    }));
    const quota = document.createElement('button');
    quota.type = 'button';
    quota.textContent = '设置额度';
    quota.addEventListener('click', () => openQuota(student));
    const quotaCell = row.insertCell();
    quotaCell.append(document.createTextNode('今日 '+student.ai_used_today+'/'+student.ai_daily_limit+
      ' · 升级剩余 '+student.ai_balance),document.createElement('br'),quota);
    row.insertCell().append(inspect,document.createTextNode(' '),button);
    return row;
  });
  $('#roster').replaceChildren(...rows);
}

function signOut(message = '') {
  session++;
  $('#quota-dialog').close();
  credential = null;
  busy = false;
  $('#dashboard').hidden = true;
  $('#admin-account').textContent = '';
  $('#login').hidden = false;
  $('#login-error').textContent = message;
  $('#new-student-id').value = '';
  $('#student-label').value = '';
  $('#issued-id').value = '';
  $('#issued').hidden = true;
  feedback('');
  detail=null;$('#student-detail').hidden=true;$('#detail-content').replaceChildren();
  $('#ai-key').value='';$('#ai-state').textContent='';
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
  const key = $('#admin-id').value;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  $('#login-error').textContent = '';
  if (!isValidId(key)) {
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
    $('#admin-account').textContent = '登录 ID ' + key;
    try {
      const settings=await request('admin',key,'ai_settings');
      if(credential===key){showAiSettings(settings);}
    }catch(error){if(credential===key)$('#ai-state').textContent=error.message;}
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
  const input = $('#new-student-id');
  const studentId = input.value;
  const label = $('#student-label').value.trim();
  if (!isValidId(studentId)) { feedback('请输入要开通的刷题 ID。', true); return; }
  $('#issued').hidden = true;
  void run(button, async (id, current) => {
    const issued = await request('admin', id, 'add', {studentId, label});
    if (session !== current) return;
    input.value = '';
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

function renderDetail(){
  if(!detail)return;
  const state=detail.state;
  const filter=$('#detail-filter').value;
  const comments=detail.comments || {};
  const questions=detail.questions.filter(q=>filter==='all' || (filter==='wrong'?state.wrong.includes(q.id):comments[q.id]));
  $('#detail-content').replaceChildren(...questions.map(q=>{
    const block=document.createElement('article');block.className='detail-question';
    const heading=document.createElement('h3');heading.textContent=detail.sections[q.sec].name+' · 第 '+q.num+' 题';
    const stem=document.createElement('p');stem.textContent=q.stem;
    const rec=state.rec[q.id];
    const stats=document.createElement('p');
    stats.textContent=rec?'作答 '+rec.a+' 次，答对 '+rec.c+' 次，最近选择 '+(rec.sel||[]).join('')+'，最近作答 '+new Date(rec.t).toLocaleString('zh-CN'):'尚未作答';
    block.append(heading,stem,stats);
    if (comments[q.id]) {
      const comment=document.createElement('p');
      comment.textContent='评论\n'+comments[q.id];
      block.append(comment);
    }
    return block;
  }));
  if(!questions.length)$('#detail-content').textContent='这个范围内暂无记录。';
}
$('#detail-filter').onchange=renderDetail;
$('#close-detail').onclick=()=>{$('#student-detail').hidden=true;detail=null;};
function showAiSettings(settings){
  $('#ai-provider').value=settings.provider;$('#ai-model').value=settings.model || (settings.provider==='doubao' ? 'doubao-seed-2-0-mini-260428' : '');
  $('#ai-enabled').checked=settings.enabled;$('#ai-limit').value=settings.dailyLimit;
  $('#ai-key').value='';
  $('#ai-state').textContent=settings.hasKey?'已保存 API Key。':'尚未配置 API Key。';
}
$('#ai-form').onsubmit=event=>{
  event.preventDefault();
  const apiKey=$('#ai-key').value.trim();
  void run(event.currentTarget.querySelector('button'),async(id,current)=>{
    const settings=await request('admin',id,'ai_save',{
      provider:$('#ai-provider').value,model:$('#ai-model').value.trim(),apiKey,
      enabled:$('#ai-enabled').checked,dailyLimit:Number($('#ai-limit').value)
    });
    if(current!==session)return;
    showAiSettings(settings);feedback('AI 设置已保存。');
    const result = await request('admin',id,'list');
    if(current===session)render(result.students);
  });
};

function showQuota(student) {
  quotaAccount = student.id;
  $('#quota-title').textContent = student.label + ' · AI 额度';
  $('#quota-status').textContent = '今日免费已用 '+student.ai_used_today+' / '+student.ai_daily_limit+
    ' 次，升级剩余 '+student.ai_balance+' 次。';
  $('#quota-daily').value = student.ai_override ?? '';
  $('#quota-adjustment').value = '';
}
function openQuota(student) {
  showQuota(student);
  $('#quota-feedback').textContent = '';
  $('#quota-dialog').showModal();
}
async function updateQuota(button, change) {
  if (!credential || busy) return;
  const key = credential;
  const account = quotaAccount;
  const status = $('#quota-feedback');
  busy = true;
  button.disabled = true;
  status.textContent = '正在保存…';
  try {
    await request('admin',key,'ai_quota',{account,...change});
    status.textContent = '已保存。';
    const result = await request('admin',key,'list');
    if (key !== credential) return;
    render(result.students);
    const student = result.students.find(item => item.id === account);
    if (student) showQuota(student);
  } catch(error) {
    if (key !== credential) return;
    if (error.denied) signOut(error.message);
    else status.textContent = (status.textContent==='已保存。' ? '已保存，关闭窗口后刷新可查看最新余额。' : error.message);
  } finally {
    busy = false;
    button.disabled = false;
  }
}
$('#quota-close').onclick = () => $('#quota-dialog').close();
$('#quota-form').onsubmit = event => {
  event.preventDefault();
  const value = $('#quota-daily').value;
  void updateQuota(event.submitter,{dailyLimit:value===''?null:Number(value)});
};
$('#balance-form').onsubmit = event => {
  event.preventDefault();
  const adjustment = Number($('#quota-adjustment').value);
  if (adjustment) void updateQuota(event.submitter,{adjustment});
};
const packageButton = $('#quota-package');
packageButton.textContent = `确认到账后加 ${AI_UPGRADE_CREDITS} 次`;
packageButton.onclick = event => {
  if (confirm(`确认已核对到账记录，并为该学员补发 ${AI_UPGRADE_CREDITS} 次 AI 解析？`)) {
    void updateQuota(event.currentTarget,{adjustment:AI_UPGRADE_CREDITS});
  }
};
