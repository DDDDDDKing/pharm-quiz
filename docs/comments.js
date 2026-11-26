export function createComments({request, questionLabel, openQuestion, escape}) {
  const openPanels = new Set();
  const drafts = new Map();
  const labels = {all:'全部',mine:'我的',saved:'已收藏'};
  const timeFormat = new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'});
  let libraryScope = 'mine';

  return function mount(root, question = null, legacyNote = '') {
    const panel = root.closest('details');
    let scope = panel ? 'all' : libraryScope;
    let page = 0;
    let sequence = 0;
    let data;
    let busy = false;
    let status = '';

    function render() {
      const items = data?.items.slice(0,25) || [];
      const mine = data?.mine;
      const content = items.map(comment => {
        const author = (comment.authorName || '学员') + (comment.mine ? '（我）' : '');
        const saved = comment.saved ? '取消收藏' : '收藏评论';
        const jump = question === null ? `<button type="button" class="btn ghost" data-jump-comment="${escape(comment.question)}">${escape(questionLabel(comment.question))}</button>` : '';
        const bookmark = comment.mine ? '' : `<button type="button" class="btn" data-bookmark="${escape(comment.id)}" aria-pressed="${comment.saved}">${saved}</button>`;
        return `<article class="comment-entry">
          <div class="comment-meta"><strong>${escape(author)}</strong><time>${escape(timeFormat.format(new Date(comment.updatedAt)))}</time></div>
          ${jump}<p>${escape(comment.text)}</p>${bookmark}
        </article>`;
      }).join('');
      const editor = question && data ? `<form class="comment-form">
        <label for="comment-text">${mine ? '编辑我的评论' : '写评论'}</label>
        <textarea id="comment-text" maxlength="10000" rows="4" required placeholder="写下解题思路或考点">${escape(drafts.get(question) ?? mine ?? legacyNote)}</textarea>
        <p class="tiny">${legacyNote && !mine ? '旧笔记已填入草稿，发布后其他学员可见。' : '发布后，登录的学员可以看到。'}</p>
        <button type="submit" class="btn primary">${mine ? '保存修改' : '发布评论'}</button>
        ${mine ? '<button type="button" class="btn" data-delete-comment>删除我的评论</button>' : ''}
      </form>` : '';
      root.innerHTML = `<div class="study-filters">${(question ? ['all','mine','saved'] : ['mine','saved']).map(tab =>
        `<button type="button" class="btn ${scope===tab?'primary':''}" data-comment-scope="${tab}" aria-pressed="${scope===tab}">${labels[tab]}</button>`).join('')}
        <button type="button" class="btn ghost" data-comment-refresh>刷新</button></div>
        <p class="tiny" role="status">${escape(status)}</p>
        ${content || (data ? '<p class="tiny">这里还没有评论。</p>' : '')}
        ${page > 0 || data?.items.length > 25 ? `<div class="study-filters">
          <button type="button" class="btn" data-comment-page="-1" ${page===0?'disabled':''}>上一页</button>
          <button type="button" class="btn" data-comment-page="1" ${data?.items.length>25?'':'disabled'}>下一页</button>
        </div>` : ''}
        ${editor}`;
    }

    async function load(message = '') {
      const id = ++sequence;
      status = '正在加载评论…';
      render();
      try {
        const result = await request('comments',{question,scope,page});
        if (id !== sequence || !root.isConnected) return;
        data = result;
        status = message;
      } catch (error) {
        if (id !== sequence || !root.isConnected) return;
        status = error.message;
      }
      render();
    }

    async function mutate(button, action, fields, message) {
      if (busy) return;
      busy = true;
      button.disabled = true;
      try {
        await request(action,fields);
        if (action === 'comment_save' || action === 'comment_delete') drafts.delete(question);
        if (root.isConnected) await load(message);
      } catch (error) {
        if (root.isConnected) root.querySelector('[role="status"]').textContent = error.message;
      } finally {
        busy = false;
        button.disabled = false;
      }
    }

    root.addEventListener('input', event => {
      if (event.target.id === 'comment-text') drafts.set(question,event.target.value);
    });
    root.addEventListener('submit', event => {
      event.preventDefault();
      const text = root.querySelector('#comment-text').value.trim();
      if (!text) {
        root.querySelector('[role="status"]').textContent = '请输入评论内容。';
        return;
      }
      void mutate(event.submitter || root.querySelector('[type="submit"]'),'comment_save',{question,text},'评论已保存。');
    });
    root.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.commentScope) {
        scope = button.dataset.commentScope;
        if (question === null) libraryScope = scope;
        page = 0;
        data = undefined;
        void load();
      } else if ('commentRefresh' in button.dataset) {
        void load();
      } else if ('commentPage' in button.dataset) {
        page += Number(button.dataset.commentPage);
        data = undefined;
        void load();
      } else if (button.dataset.bookmark) {
        const saved = button.getAttribute('aria-pressed') !== 'true';
        void mutate(button,'comment_bookmark',{comment:button.dataset.bookmark,saved},saved?'评论已收藏。':'已取消收藏。');
      } else if ('deleteComment' in button.dataset && confirm('删除这条评论？')) {
        void mutate(button,'comment_delete',{question},'评论已删除。');
      } else if (button.dataset.jumpComment) {
        openPanels.add(button.dataset.jumpComment);
        openQuestion(button.dataset.jumpComment);
      }
    });

    if (panel) {
      panel.open = openPanels.has(question);
      panel.addEventListener('toggle', () => {
        if (!root.isConnected) return;
        if (panel.open) {
          openPanels.add(question);
          if (!sequence) void load();
        } else {
          openPanels.delete(question);
        }
      });
      if (panel.open) void load();
    } else {
      void load();
    }
  };
}
