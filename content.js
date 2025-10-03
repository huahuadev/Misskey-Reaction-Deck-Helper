
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
    return sanitizeReactions(Array.isArray(kv) ? kv : []);
  } catch (e) {
    const msg = (e && (e.error || e.message)) || 'unknown error';
    alert('リアクションデッキの取得に失敗しました: ' + msg);
    throw e;
  }
}

// reactions を更新。
async function setReactions(list) {
  try {
    const cleaned = sanitizeReactions(list);
    console.log("cleaned", cleaned);
    console.log("list", list);
    console.log("Array.isArray(list)", Array.isArray(list));
    console.log("list.length", list.length);
    console.log("cleaned.length", cleaned.length);
    if (cleaned.length !== (Array.isArray(list) ? list.length : 0)) {
      alert('リアクションデッキの編集中にエラーが発生したため、変更をキャンセルしました。');
      return;
    }
    await apiPost('i/registry/set', { scope: ['client', 'base'], key: 'reactions', value: cleaned });
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

  // デッキ（ピン留め）グリッド用のドラッグ&ドロップを初期化
  setupDeckDnd(scope);
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

// DnD
function setupDeckDnd(scope) {
  // .group.index 配下の最初の section が deck（ピン留め）で、最近使用や他セクションは header を持つ
  const group = scope.querySelector && scope.querySelector('.group.index');
  if (!group) return;
  const firstSection = group.querySelector(':scope > section:first-child');
  if (!firstSection) return;
  // 安全ガード: header がある = 最近使用 なので DnD 対象外
  if (firstSection.querySelector(':scope > header')) return;
  const deckBody = firstSection.querySelector(':scope > .body');
  if (!deckBody) return;
  if (deckBody.__mrdhDndSetup) return;
  deckBody.__mrdhDndSetup = true;

  const addHandles = () => {
    const cells = deckBody.querySelectorAll('button._button.item, ._button.item');
    cells.forEach(cell => {
      // 透明ハンドル（クリック領域を確保）
      if (!cell.querySelector('.mrdh-dnd-handle')) {
        const handle = document.createElement('div');
        handle.className = 'mrdh-dnd-handle';
        handle.addEventListener('mousedown', (ev) => beginDeckDrag(ev, deckBody));
        cell.style.position = cell.style.position || 'relative';
        cell.appendChild(handle);
      }
      // 通常の DnD と同様、セルの mousedown ですぐ開始
      if (!cell.__mrdhDndCell) {
        cell.__mrdhDndCell = true;
        cell.addEventListener('mousedown', (ev) => beginDeckDrag(ev, deckBody));
      }
    });
  };
  addHandles();

  // 変化に追従
  const obs = new MutationObserver(() => addHandles());
  obs.observe(deckBody, { childList: true, subtree: true });
}

function beginDeckDrag(ev, deckBody) {
  if (ev.button !== 0) return; // left only
  ev.preventDefault();
  const cell = (ev.currentTarget && ev.currentTarget.closest) ? ev.currentTarget.closest('button._button.item, ._button.item') : (ev.target && ev.target.closest ? ev.target.closest('button._button.item, ._button.item') : null);
  if (!cell) return;
  const cells = Array.from(deckBody.querySelectorAll('button._button.item, ._button.item'));
  const startIndex = cells.indexOf(cell);
  if (startIndex < 0) return;

  const insertLine = document.createElement('div');
  insertLine.className = 'mrdh-insert-line';
  document.body.appendChild(insertLine);

  // ドラッグ中のゴースト
  const ghost = document.createElement('div');
  ghost.className = 'mrdh-ghost';
  ghost.innerHTML = cell.innerHTML;
  document.body.appendChild(ghost);
  const updateGhost = (e) => {
    ghost.style.left = (e.clientX + 8) + 'px';
    ghost.style.top = (e.clientY + 8) + 'px';
  };
  updateGhost(ev);

  // 視覚的に掴んでいることを示す
  cell.classList.add('mrdh-dragging');
  const prevCursor = document.body.style.cursor;
  document.body.style.cursor = 'grabbing';

  function placeInsertAt(index, clientY) {
    // index は 0..cells.length の間の挿入位置
    const last = cells[cells.length - 1];
    const rect = (index >= cells.length ? last : cells[index]).getBoundingClientRect();
    const x = index >= cells.length ? (last.getBoundingClientRect().right) : rect.left;
    insertLine.style.left = (x - 2) + 'px';
    insertLine.style.top = rect.top + 'px';
    insertLine.style.height = rect.height + 'px';
  }

  function computeIndex(clientX, clientY) {
    // 最も近いセルの左/右で before/after を決める
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const r = cells[i].getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const d = Math.hypot(cx - clientX, cy - clientY);
      if (d < best) { best = d; nearest = i; }
    }
    const r = cells[nearest].getBoundingClientRect();
    const before = clientX < (r.left + r.width / 2);
    return before ? nearest : (nearest + 1);
  }

  let currentIndex = startIndex;
  function onMove(e) {
    const idx = computeIndex(e.clientX, e.clientY);
    currentIndex = idx;
    placeInsertAt(idx, e.clientY);
    updateGhost(e);
  }
  function onUp(e) {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    insertLine.remove();
    ghost.remove();
    cell.classList.remove('mrdh-dragging');
    document.body.style.cursor = prevCursor;
    const to = currentIndex > cells.length ? cells.length : currentIndex;
    if (to === startIndex || to === startIndex + 1) return;
    // 並べ替え実行
    getReactions().then(list => {
      const next = moveOne(list, startIndex, to > startIndex ? to - 1 : to);
      return setReactions(next).then(() => {
        // 視覚フィードバック: DOM も入れ替える
        if (to > startIndex) {
          deckBody.insertBefore(cells[startIndex], cells[to - 1].nextSibling);
        } else {
          deckBody.insertBefore(cells[startIndex], cells[to]);
        }
      });
    }).catch(() => {});
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
function moveOne(arr, from, to) {
  const a = arr.slice();
  const [el] = a.splice(from, 1);
  a.splice(to, 0, el);
  return a;
}

// ------------------ validation helpers ------------------
function sanitizeReactions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    if (typeof v === 'string' && isValidEmojiKey(v)) out.push(v);
  }
  return out;
}


