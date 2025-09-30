
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

// reactions（=リアクションデッキ）を取得。
async function getReactions() {
  try {
    const kv = await apiPost('i/registry/get', { scope: ['client', 'base'], key: 'reactions' });
    return Array.isArray(kv) ? kv : [];
  } catch (e) {
    const msg = (e && (e.error || e.message)) || 'unknown error';
    alert('リアクションデッキの取得に失敗しました: ' + msg);
    throw e;
  }
}

// reactions を更新。
async function setReactions(list) {
  try {
    await apiPost('i/registry/set', { scope: ['client', 'base'], key: 'reactions', value: list });
  } catch (e) {
    const msg = (e && (e.error || e.message)) || 'unknown error';
    alert('リアクションデッキの更新に失敗しました: ' + msg);
    throw e;
  }
}

// リアクションデッキに追加/削除を行う。
// forceAdd が true の場合は必ず追加、false の場合は必ず削除、未指定の場合はトグル。
async function toggleReactionDeck(emoji, forceAdd) {
  try {
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
  } catch (e) {
    // get/set 内で alert 済み。
  }
}

function showMiniMenu(x, y, onAdd, onRemove, isAlreadyInDeck) {
  // 右クリック時に表示するミニメニュー（追加/削除）
  const menu = document.createElement('div');
  menu.className = 'mrdh-menu';
  const addDisabled = isAlreadyInDeck ? ' disabled' : '';
  const addLabel = isAlreadyInDeck ? 'デッキに追加済み' : 'デッキに追加';
  const addClass = isAlreadyInDeck ? ' mrdh-added' : '';
  const addTitle = isAlreadyInDeck ? 'すでにデッキに追加されています' : '';
  const removeDisabled = isAlreadyInDeck ? '' : ' disabled';
  const removeTitle = isAlreadyInDeck ? '' : 'デッキに追加されていません';
  menu.innerHTML = '<button class="mrdh-item' + addClass + '" data-act="add"' + addDisabled + (addTitle ? ' title="' + addTitle + '"' : '') + '>' + addLabel + '</button>' +
                   '<button class="mrdh-item mrdh-remove" data-act="remove"' + removeDisabled + (removeTitle ? ' title="' + removeTitle + '"' : '') + '>デッキから削除</button>';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);
  const cleanup = () => menu.remove();
  menu.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const act = t.dataset.act;
    if (t.hasAttribute('disabled')) return;
    if (act === 'add') onAdd();
    if (act === 'remove') onRemove();
    cleanup();
  });
  setTimeout(() => {
    const off = (e) => { if (!menu.contains(e.target)) { cleanup(); document.removeEventListener('mousedown', off); } };
    document.addEventListener('mousedown', off);
  }, 0);
}

// 抽出した値が Misskey のリアクションキーとして妥当かを判定
function isValidEmojiKey(key) {
  if (typeof key !== 'string') return false;
  const s = key.trim();
  if (s.length === 0) return false;
  // カスタム絵文字 :shortcode:
  if (s.startsWith(':') && s.endsWith(':') && s.length > 2 && !/\s/.test(s)) return true;
  // Unicode 絵文字（拡張絵文字の正規表現）
  try {
    return /\p{Extended_Pictographic}/u.test(s);
  } catch {
    // 環境によっては Unicode プロパティ未対応のため簡易判定
    return s.length <= 8 && !s.includes(' ');
  }
}

// リアクションセルからリアクション情報を取得する。
function extractEmojiFromCell(cell) {
  if (!cell) return null;
  // 1) data-emoji（最近/ピン/一部セクション）
  const fromData = (cell.getAttribute && cell.getAttribute('data-emoji')) || (cell.dataset && cell.dataset.emoji);
  if (isValidEmojiKey(fromData)) return fromData;
  // 2) 検索結果など: 内部の .emoji 要素の alt / テキスト
  const emojiEl = cell.querySelector && cell.querySelector('.emoji');
  if (emojiEl) {
    const alt = emojiEl.getAttribute && emojiEl.getAttribute('alt');
    if (isValidEmojiKey(alt)) return alt;
    const txt = emojiEl.textContent && emojiEl.textContent.trim();
    if (isValidEmojiKey(txt)) return txt;
  }
  // 3) 互換: 子孫の img[alt]
  const img = cell.querySelector && cell.querySelector('img[alt]');
  if (isValidEmojiKey(img && img.alt)) return img.alt;
  // 4) 予備: title だが、必ず妥当性チェックを行う
  const title = cell.getAttribute && cell.getAttribute('title');
  if (isValidEmojiKey(title)) return title;
  return null;
}

// それぞれのリアクションセルに対して、右クリックメニューの表示を設定する。
function bindCell(cell) {
  if (cell.__mrdhBound) return;
  cell.__mrdhBound = true;
  const emoji = extractEmojiFromCell(cell);
  if (!emoji) return;
  // 右クリックでメニューを表示するリスナーを追加（Misskey 本体のメニューとは独立）
  cell.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const list = await getReactions();
    const has = list.includes(emoji);
    showMiniMenu(e.clientX, e.clientY,
      async () => { await toggleReactionDeck(emoji, true); },
      async () => { await toggleReactionDeck(emoji, false); },
      has,
    );
  }, { passive: false });
}

// リアクションピッカーをスキャンし、右クリックメニューの表示を追加する。
function scanPicker(root) {
  // ピッカー本体（.emojis）配下のセルを幅広く対象化（最近/検索結果/カスタム）
  const scope = root.querySelector ? (root.querySelector('.emojis') || root) : root;
  const items = scope.querySelectorAll('button._button.item, ._button.item');
  items.forEach(bindCell);
  // デリゲーション（disabled ボタンや未バインドセルにも対応）
  if (!scope.__mrdhDelegated) {
    scope.__mrdhDelegated = true;
    scope.addEventListener('contextmenu', async (e) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!target) return;
      const cell = target.closest ? target.closest('button._button.item, ._button.item') : null;
      if (!cell) return;
      const emoji = extractEmojiFromCell(cell);
      if (!emoji) return;
      e.preventDefault();
      const list = await getReactions();
      const has = list.includes(emoji);
      showMiniMenu(e.clientX, e.clientY,
        async () => { await toggleReactionDeck(emoji, true); },
        async () => { await toggleReactionDeck(emoji, false); },
        has,
      );
    }, true);
  }
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


