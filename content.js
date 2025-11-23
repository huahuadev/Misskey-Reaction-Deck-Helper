
// 簡易ロガー（info は localStorage.mrdh-debug == '1' の時のみ出力、error は常に出力）
(function setupMrdhLogger() {
  try {
    const isDebug = () => {
      try { return localStorage.getItem('mrdh-debug') === '1'; } catch { return false; }
    };
    const info = function() {
      if (!isDebug()) return;
      try { console.log('[MRDH]', ...arguments); } catch {}
    };
    const error = function() {
      try { console.log('[⚠MRDH:error]', ...arguments); } catch {}
    };
    window.__mrdhLog = { info, error };
    // 予期しない例外を捕捉
    window.addEventListener('error', (ev) => error('window.error', ev.error || ev.message));
    window.addEventListener('unhandledrejection', (ev) => error('unhandledrejection', ev.reason));
    info('MRDH ロガーを初期化しました');
  } catch {}
})();

// ------------------ Preferences helpers ------------------
const SYNC_REGISTRY_SCOPE = ['client', 'preferences', 'sync'];
const SYNC_REGISTRY_KEY = 'default:emojiPalettes';

function getServerHost() {
  return location.host || location.hostname;
}

function getCurrentAccountId() {
  try {
    const accountRaw = localStorage.getItem('account');
    if (!accountRaw) return null;
    const account = JSON.parse(accountRaw);
    return account?.id ?? null;
  } catch {
    return null;
  }
}

function loadPreferencesProfile() {
  try {
    const raw = localStorage.getItem('preferences');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    (window.__mrdhLog?.error || function(){})('preferences の読み込みに失敗しました', err);
    return null;
  }
}

function savePreferencesProfile(profile) {
  try {
    profile.modifiedAt = Date.now();
    if (!profile.version) profile.version = 'ext';
    localStorage.setItem('preferences', JSON.stringify(profile));
    localStorage.setItem('latestPreferencesUpdate', `ext/${Date.now()}`);
    (window.__mrdhLog?.info || function(){})('設定を localStorage に書き込みました');
    return true;
  } catch (err) {
    (window.__mrdhLog?.error || function(){})('設定の保存に失敗しました', err);
    alert('設定の保存に失敗しました。ページを再読み込みして再試行してください。');
    return false;
  }
}

function parseScope(scope) {
  return {
    server: scope?.server ?? null,
    account: scope?.account ?? null,
    device: scope?.device ?? null,
  };
}

// Misskey 本体の getMatchedRecordOf() 相当。
// 「ログイン中のアカウント + 対象サーバー + デバイス (将来)」に最も近いレコードを選ぶ。
function findScopedPreferenceRecord(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const server = getServerHost();
  const account = getCurrentAccountId();
  let best = { index: -1, record: null, score: -1 };

  records.forEach((rec, idx) => {
    const scope = parseScope(rec[0] || {});
    if (scope.account && (!account || scope.account !== account)) return;
    if (scope.server && (!server || scope.server !== server)) return;

    // account > server > global の優先順位になるようにスコア化
    let score = 0;
    if (scope.account && account) score += 4;
    if (scope.server && server) score += 2;
    if (!scope.account) score += 1;
    if (!scope.server) score += 1;

    if (score > best.score) {
      best = { index: idx, record: rec, score };
    }
  });

  if (best.index >= 0) {
    return { index: best.index, record: best.record };
  }
  // どのレコードにもマッチできなかった場合は最初のレコードを返す（Misskey 本体と同じ挙動）
  return { index: 0, record: records[0] };
}

// emojiPaletteForReaction のレコードから、ユーザーが UI 上で選択したパレットIDを特定する。
function determineActiveReactionPaletteId(profile, palettes) {
  if (!profile?.preferences) return null;
  const records = profile.preferences['emojiPaletteForReaction'];
  const selected = findScopedPreferenceRecord(records);
  const value = selected?.record?.[1];
  if (typeof value === 'string' && value.length > 0) return value;
  return palettes?.[0]?.id ?? null;
}

function isSameScope(a, b) {
  const pa = parseScope(a);
  const pb = parseScope(b);
  return pa.server == pb.server && pa.account == pb.account && pa.device == pb.device;
}

async function syncEmojiPalettesToCloud(scope, value) {
  try {
    let cloudData = [];
    try {
      cloudData = await apiPost('i/registry/get', {
        scope: SYNC_REGISTRY_SCOPE,
        key: SYNC_REGISTRY_KEY,
      });
    } catch (err) {
      if (err && err.code === 'NO_SUCH_KEY') {
        cloudData = [];
      } else {
        throw err;
      }
    }

    const idx = cloudData.findIndex(([sc]) => isSameScope(sc, scope));
    const entry = [scope || {}, value];
    if (idx === -1) cloudData.push(entry);
    else cloudData[idx] = entry;

    await apiPost('i/registry/set', {
      scope: SYNC_REGISTRY_SCOPE,
      key: SYNC_REGISTRY_KEY,
      value: cloudData,
    });
    (window.__mrdhLog?.info || function(){})('クラウド同期 (emojiPalettes) が完了しました');
  } catch (err) {
    (window.__mrdhLog?.error || function(){})('クラウド同期 (emojiPalettes) に失敗しました', err);
  }
}

function schedulePreferencesRefresh(waitTimeMS = 100) {
  try {
    setTimeout(() => {
      try {
        const evt = new Event('visibilitychange');
        document.dispatchEvent(evt);
        (window.__mrdhLog?.info || function(){})('visibilitychange を送信して Misskey に更新を通知しました');
      } catch (err) {
        (window.__mrdhLog?.error || function(){})('visibilitychange の送信に失敗しました', err);
      }
    }, waitTimeMS);
  } catch (err) {
    (window.__mrdhLog?.error || function(){})('設定同期リフレッシュの予約に失敗しました', err);
  }
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
  (window.__mrdhLog?.info || function(){})('API 呼び出しを開始しました', { path, payloadKeys: body ? Object.keys(body) : [] });
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
    (window.__mrdhLog?.error || function(){})('API 呼び出しでエラーが発生しました', { path, err });
    throw err.error || err;
  }
  (window.__mrdhLog?.info || function(){})('API 呼び出しが完了しました', { path, status: res.status });
  if (res.status === 204) return undefined;
  return await res.json();
}

// reactions（=リアクションデッキ）を取得。
async function getReactions() {
  try {
    const ctx = resolveActiveReactionPaletteContext();
    if (!ctx) {
      alert('リアクションパレットを取得できませんでした。ページを再読み込みしてください。');
      throw new Error('reaction palette not found');
    }
    const emojis = Array.isArray(ctx.palette?.emojis) ? ctx.palette.emojis.slice() : [];
    const cleaned = sanitizeReactions(emojis);
    (window.__mrdhLog?.info || function(){})('操作対象パレットの絵文字一覧を取得しました', { count: cleaned.length });
    return cleaned;
  } catch (e) {
    const msg = (e && (e.error || e.message)) || 'unknown error';
    alert('リアクションデッキの取得に失敗しました: ' + msg);
    (window.__mrdhLog?.error || function(){})('操作対象パレットの取得に失敗しました', e);
    throw e;
  }
}

// reactions を更新。
async function setReactions(list) {
  try {
    if (!Array.isArray(list)) {
      alert('リアクションデッキの形式が不正です（配列ではありません）。更新をキャンセルしました。');
      (window.__mrdhLog?.error || function(){})('setReactions に配列以外の値が渡されました', typeof list);
      return;
    }
    const ctx = resolveActiveReactionPaletteContext();
    if (!ctx) {
      alert('リアクションパレットを更新できませんでした。ページを再読み込みしてください。');
      throw new Error('reaction palette not found');
    }
    const cleaned = sanitizeReactions(list);
    if (cleaned.length !== list.length) {
      alert('リアクションデッキの編集中に不正な値が検出されたため、変更をキャンセルしました。');
      (window.__mrdhLog?.error || function(){})('setReactions で不正な絵文字が検出されたため処理を中断しました', { original: list, sanitized: cleaned });
      return;
    }

    const nextPalettes = ctx.palettes.slice();
    const nextPalette = {
      ...ctx.palette,
      emojis: cleaned,
    };
    nextPalettes[ctx.paletteIndex] = nextPalette;

    ctx.profile.preferences.emojiPalettes[ctx.recordIndex] = [
      ctx.scope,
      nextPalettes,
      ctx.meta,
    ];

    if (!savePreferencesProfile(ctx.profile)) return;
    (window.__mrdhLog?.info || function(){})('ローカル preferences に絵文字リストを保存しました', { count: cleaned.length });

    if (ctx.meta?.sync) {
      (window.__mrdhLog?.info || function(){})('sync が有効なためクラウド同期を開始します');
      await syncEmojiPalettesToCloud(ctx.scope, nextPalettes);
    }
    schedulePreferencesRefresh(100);
  } catch (e) {
    const msg = (e && (e.error || e.message)) || 'unknown error';
    alert('リアクションデッキの更新に失敗しました: ' + msg);
    (window.__mrdhLog?.error || function(){})('パレットの保存処理でエラーが発生しました', e);
    throw e;
  }
}

// リアクションデッキに追加/削除を行う。
// forceAdd が true の場合は必ず追加、false の場合は必ず削除、未指定の場合はトグル。
async function toggleReactionDeck(emoji, forceAdd) {
  try {
    (window.__mrdhLog?.info || function(){})('リアクションデッキの追加/削除を開始します', { emoji, forceAdd });
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
    (window.__mrdhLog?.info || function(){})('リアクションデッキの更新が完了しました', { emoji, forceAdd });
  } catch (e) {
    // get/set 内で alert 済み。
    (window.__mrdhLog?.error || function(){})('リアクションデッキの更新に失敗しました', e);
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
    try {
      e.preventDefault();
      const list = await getReactions();
      const has = list.includes(emoji);
      showMiniMenu(e.clientX, e.clientY,
        async () => { await toggleReactionDeck(emoji, true); },
        async () => { await toggleReactionDeck(emoji, false); },
        has,
      );
    } catch (err) {
      (window.__mrdhLog?.error || function(){})('右クリックメニューの処理に失敗しました', err);
    }
  }, { passive: false });
}

// リアクションピッカーをスキャンし、右クリックメニューの表示を追加する。
function scanPicker(root) {
  const host = findEmojiPickerHost(root);
  const scope = host?.querySelector?.('.emojis') ||
    (root instanceof HTMLElement && root.classList.contains('emojis') ? root :
      (root.querySelector ? root.querySelector('.emojis') : null));
  if (!scope) {
    (window.__mrdhLog?.info || function(){})('絵文字ピッカーがまだ表示されていないためスキャンをスキップしました');
    return;
  }
  if (host && isNoteEditorEmojiPicker(host)) {
    (window.__mrdhLog?.info || function(){})('ノート入力用の絵文字ピッカーを検出したため拡張機能を無効化しました');
    return;
  }
  const items = scope.querySelectorAll('button._button.item, ._button.item');
  (window.__mrdhLog?.info || function(){})('リアクション用の絵文字ピッカーをスキャンしています', { cellCount: items.length });
  items.forEach(bindCell);
  // デリゲーション（disabled ボタンや未バインドセルにも対応）
  if (!scope.__mrdhDelegated) {
    scope.__mrdhDelegated = true;
    scope.addEventListener('contextmenu', async (e) => {
      try {
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
      } catch (err) {
        (window.__mrdhLog?.error || function(){})('右クリックメニュー（デリゲート）の処理に失敗しました', err);
      }
    }, true);
  }

  // デッキ（ピン留め）グリッド用のドラッグ&ドロップを初期化
  setupDeckDnd(scope);
}

// ノート作成フォーム用の絵文字ピッカーかどうかを推定する。
// Misskey 本体では asWindow クラス付きのピッカーがノート編集用として開かれる。
function isNoteEditorEmojiPicker(el) {
  if (!(el instanceof HTMLElement)) return false;
  const host = el.matches && el.matches('.omfetrab') ? el : (el.closest ? el.closest('.omfetrab') : null);
  if (!host) return false;
  if (host.classList.contains('asWindow')) return true;
  return false;
}

function findEmojiPickerHost(el) {
  if (!(el instanceof HTMLElement)) return null;
  if (el.matches && el.matches('.omfetrab')) return el;
  return el.closest ? el.closest('.omfetrab') : null;
}

// ピッカーの出現を監視し、右クリックメニューの表示などを対応する。
const mo = new MutationObserver((muts) => {
  for (const m of muts) {
    m.addedNodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      const host = findEmojiPickerHost(node);
      if (host) {
        (window.__mrdhLog?.info || function(){})('絵文字ピッカーの生成を検出したため再スキャンします');
        scanPicker(host);
        return;
      }
      if (node.querySelectorAll) {
        node.querySelectorAll('.omfetrab').forEach((innerHost) => {
          (window.__mrdhLog?.info || function(){})('絵文字ピッカーの生成を検出したため再スキャンします');
          scanPicker(innerHost);
        });
      }
    });
  }
});

mo.observe(document.documentElement, { childList: true, subtree: true });

// 初期スキャン（既にピッカーが開いている場合にも対応）
document.querySelectorAll('.omfetrab').forEach((host) => {
  scanPicker(host);
});

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

// emojiPalettes レコードから、現在操作対象となるパレットと関連メタ情報を集める。
// Misskey 本体側の PreferencesManager と同様のロジックでスコープに合うレコードを優先的に選び出す。
function resolveActiveReactionPaletteContext() {
  const profile = loadPreferencesProfile();
  if (!profile?.preferences) return null;
  const records = profile.preferences['emojiPalettes'];
  const selection = findScopedPreferenceRecord(records);
  if (!selection) return null;
  const [scope, palettes, meta = {}] = selection.record;
  if (!Array.isArray(palettes) || palettes.length === 0) return null;
  const paletteId = determineActiveReactionPaletteId(profile, palettes);
  let paletteIndex = paletteId ? palettes.findIndex((p) => p.id === paletteId) : 0;
  if (paletteIndex < 0) paletteIndex = 0;
  const palette = palettes[paletteIndex];
  if (!palette) return null;
  (window.__mrdhLog?.info || function(){})('操作対象の絵文字パレットを特定しました', {
    paletteId,
    paletteIndex,
    paletteEmojiCount: Array.isArray(palette?.emojis) ? palette.emojis.length : 0,
    totalPalettes: palettes.length,
  });
  return {
    profile,
    recordIndex: selection.index,
    scope: scope || {},
    meta,
    palettes,
    palette,
    paletteIndex,
  };
}


