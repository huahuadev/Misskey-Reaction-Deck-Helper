(function() {
  // ページ内の defaultStore を取得（存在しない場合は null）
  function getStore() {
    try {
      if (window.defaultStore) return window.defaultStore;
    } catch {}
    try {
      const g = globalThis || window;
      if (g.defaultStore) return g.defaultStore;
    } catch {}
    return null;
  }

  // content.js からの postMessage を受け取り、必要な処理を defaultStore に委譲
  async function handleRequest(ev) {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.type !== 'MRDH_PAGE_REQUEST') return;
    const { reqId, method, payload } = data;
    let result = null;
    try {
      const store = getStore();
      if (!store) throw new Error('defaultStore not found');
      if (method === 'getReactions') {
        // reactions（=リアクションデッキ）を返す
        result = store.state?.reactions || store.reactiveState?.reactions?.value || [];
      } else if (method === 'setReactions') {
        // reactions を更新（defaultStore に保存。内部で i/registry/set が呼ばれてサーバへ永続化）
        const list = Array.isArray(payload?.list) ? payload.list : [];
        await store.set('reactions', list);
        result = true;
      }
    } catch (e) {
      result = { error: String(e && e.message || e) };
    }
    // 呼び出し元へ結果を返す
    window.postMessage({ type: 'MRDH_PAGE_RESPONSE', reqId, result }, '*');
  }

  window.addEventListener('message', handleRequest);
})();



