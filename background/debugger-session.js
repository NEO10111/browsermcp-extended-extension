/** Share one Chrome debugger attachment between capture and short operations. */
(() => {
  const counts = new Map();
  const queues = new Map();
  function serial(tabId, action) {
    const next = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(action);
    queues.set(tabId, next);
    next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
    return next;
  }
  self.BrowserMcpDebugger = {
    acquire(tabId) {
      return serial(tabId, async () => {
        if (!counts.get(tabId)) await chrome.debugger.attach({ tabId }, '1.3');
        counts.set(tabId, (counts.get(tabId) || 0) + 1);
      });
    },
    release(tabId) {
      return serial(tabId, async () => {
        const count = counts.get(tabId) || 0;
        if (count > 1) counts.set(tabId, count - 1);
        else if (count) {
          counts.delete(tabId);
          try { await chrome.debugger.detach({ tabId }); } catch {}
        }
      });
    },
  };
  chrome.debugger.onDetach?.addListener(({ tabId }) => counts.delete(tabId));
})();
