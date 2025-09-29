// defaultStore に触るため、ページ側に injected.js を注入する。
(function inject() {
  try {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.type = 'text/javascript';
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
  } catch {}
})();

// ページ側(injected.js)と postMessage でやり取りするヘルパ。
function callPage(method, payload) {
  return new Promise((resolve) => {
    // Misskey Reaction Deck Helper の略で reqId を生成
    const reqId = 'mrdh-' + Math.random().toString(36).slice(2);
    function onMessage(ev) {
      if (ev.source !== window) return;
      const data = ev.data;
      if (!data || data.type !== 'MRDH_PAGE_RESPONSE' || data.reqId !== reqId) return;
      window.removeEventListener('message', onMessage);
      resolve(data.result);
    }
    window.addEventListener('message', onMessage);
    try { window.postMessage({ type: 'MRDH_PAGE_REQUEST', reqId, method, payload }, '*'); } catch { resolve(undefined); }
  });
}

// ログイン済みユーザーのトークンを Misskey 本体の localStorage から取得する。
function getAccountToken() {
  try {
    const raw = localStorage.getItem('account');
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj.token === 'string' ? obj.token : null;
  } catch { return null; }
}

// Misskey API の URL を作成（/api/ 以下のエンドポイントを想定）
function apiUrl(path) {
  return `${location.origin}/api/${path}`.replace(/\/+$/,'').replace(/([^:])\/\/+/, '$1/');
}

// Misskey API を呼び出す（Bearer トークン利用）。エラー時は JSON をそのまま投げ直す。
async function apiPost(path, body) {
  const token = getAccountToken();
  if (!token) throw new Error('No token');
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let err;
    try { err = await res.json(); } catch { err = { statusCode: res.status, message: res.statusText }; }
    throw err.error || err;
  }
  if (res.status === 204) return undefined;
  return await res.json();
}

// reactions（=リアクションデッキ）を取得。まず API を試し、失敗時はページから defaultStore にアクセスするようフォールバック。
async function getReactions() {
  try {
    const kv = await apiPost('i/registry/get', { scope: ['client', 'base'], key: 'reactions' });
    return Array.isArray(kv) ? kv : [];
  } catch (e) {
    const res = await callPage('getReactions');
    return Array.isArray(res) ? res : [];
  }
}

// reactions を更新。まず API を試し、失敗時はページから defaultStore にアクセスするようフォールバック。
async function setReactions(list) {
  try {
    await apiPost('i/registry/set', { scope: ['client', 'base'], key: 'reactions', value: list });
  } catch (e) {
    await callPage('setReactions', { list });
  }
}

// リアクションデッキに追加/削除を行う。
// forceAdd が true の場合は必ず追加、false の場合は必ず削除、未指定の場合はトグル。
async function toggleReactionDeck(emoji, forceAdd) {
  const list = await getReactions();
  const set = new Set(list);
  const has = set.has(emoji);
  if (forceAdd === true) {
    if (!has) set.add(emoji);
  } else if (forceAdd === false) {
    if (has) set.delete(emoji);
  } else {
    if (has) set.delete(emoji); else set.add(emoji);
  }
  await setReactions(Array.from(set));
}

function showMiniMenu(x, y, onAdd, onRemove) {
  // 右クリック時に表示するミニメニュー（追加/削除）
  const menu = document.createElement('div');
  menu.className = 'mrdh-menu';
  menu.innerHTML = '<button class="mrdh-item" data-act="add">デッキに追加</button>' +
                   '<button class="mrdh-item" data-act="remove">デッキから削除</button>';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  const cleanup = () => menu.remove();
  menu.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const act = t.dataset.act;
    if (act === 'add') onAdd();
    if (act === 'remove') onRemove();
    cleanup();
  });
  setTimeout(() => {
    const off = (e) => { if (!menu.contains(e.target)) { cleanup(); document.removeEventListener('mousedown', off); } };
    document.addEventListener('mousedown', off);
  }, 0);
}

// リアクションセルからリアクション情報を取得する。
function extractEmojiFromCell(cell) {
  const fromData = cell.getAttribute('data-emoji') || cell.dataset.emoji;
  if (fromData) return fromData;
  // TODO: 互換フォールバックが出来ればここに追加
  return null;
}

// それぞれのリアクションセルに対して、右クリックメニューの表示を設定する。
function bindCell(cell) {
  if (cell.__mrdhBound) return;
  cell.__mrdhBound = true;
  const emoji = extractEmojiFromCell(cell);
  if (!emoji) return;
  // 右クリックでメニューを表示（Misskey 本体のメニューとは独立）
  cell.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    showMiniMenu(e.clientX, e.clientY,
      async () => { await toggleReactionDeck(emoji, true); },
      async () => { await toggleReactionDeck(emoji, false); },
    );
  }, { passive: false });
}

// リアクションピッカーをスキャンし、右クリックメニューの表示を追加する。
function scanPicker(root) {
  // ピッカー本体（.emojis）配下のセルを幅広く対象化（最近/検索結果/カスタム）
  const scope = root.querySelector ? (root.querySelector('.emojis') || root) : root;
  const items = scope.querySelectorAll('button._button.item, ._button.item');
  items.forEach(bindCell);
}

// リアクションピッカーのルート要素かどうかを判定する。
function isEmojiPickerRoot(el) {
  if (!(el instanceof HTMLElement)) return false;
  return !!(el.querySelector && el.querySelector('input.mk-input-search') && el.querySelector('.emojis'));
}

// ピッカーの出現を監視し、右クリックメニューの表示などを対応する。
const mo = new MutationObserver((muts) => {
  for (const m of muts) {
    m.addedNodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      if (isEmojiPickerRoot(node) || (node.querySelector && node.querySelector('.emojis'))) {
        // ピッカー全体 または ピッカー内部が生成されたタイミングで再スキャン
        scanPicker(node);
      }
    });
  }
});

mo.observe(document.documentElement, { childList: true, subtree: true });

// 初期スキャン（既にピッカーが開いている場合にも対応）
scanPicker(document.documentElement);


