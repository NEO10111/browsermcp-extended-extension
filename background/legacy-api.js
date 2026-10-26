/** BrowserMCP Extended: handlers for the original browser tools on the shared socket. */
self.BrowserMcpLegacy = (() => {
  const refs = new Map();
  const consoleLogs = [];
  function recordConsole(entries) {
    if (!Array.isArray(entries)) return;
    consoleLogs.push(...entries);
    if (consoleLogs.length > 100) consoleLogs.splice(0, consoleLogs.length - 100);
  }
  let observedTab = null;

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0] || (await chrome.tabs.query({ active: true }))[0];
    if (!tab?.id) throw new Error('Aucun onglet actif');
    return tab;
  }

  async function run(tabId, func, args = []) {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    if (!injection) throw new Error('Aucun résultat de la page');
    if (injection.error) throw new Error(injection.error.message || String(injection.error));
    return injection.result;
  }


  async function waitForLoad(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        reject(new Error('Chargement de la page trop long'));
      }, 15000);
      const onUpdated = (id, change) => {
        if (id !== tabId || change.status !== 'complete') return;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  }

  function selectorFor(ref, tabId) {
    const entry = refs.get(ref);
    if (!entry || entry.tabId !== tabId) throw new Error(`Référence ${ref} expirée : refaites un snapshot`);
    return entry.selector;
  }

  function snapshotInPage() {
    const escape = (value) => CSS.escape(value);
    const selector = (el) => {
      if (el.id) return `#${escape(el.id)}`;
      const parts = [];
      while (el && el !== document.body && parts.length < 12) {
        let part = el.localName;
        let i = 1;
        for (let node = el.previousElementSibling; node; node = node.previousElementSibling) {
          if (node.localName === el.localName) i++;
        }
        part += `:nth-of-type(${i})`;
        parts.unshift(part);
        el = el.parentElement;
      }
      return `body > ${parts.join(' > ')}`;
    };
    const nodes = [...document.querySelectorAll('a,button,input,select,textarea,[role],[tabindex]')]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
      .slice(0, 250);
    return nodes.map((el, index) => ({
      ref: `e${index + 1}`,
      selector: selector(el),
      role: el.getAttribute('role') || el.localName,
      name: (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    }));
  }

  async function interact(tabId, selector, action, params = {}) {
    return run(tabId, (css, kind, data) => {
      const el = document.querySelector(css);
      if (!el) throw new Error(`Élément introuvable : ${css}`);
      if (kind === 'click') el.click();
      else if (kind === 'hover') el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      else if (kind === 'type') {
        el.focus();
        const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (!setter) throw new Error('Cet élément ne permet pas la saisie');
        setter.call(el, data.text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: data.text, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (data.submit) el.form?.requestSubmit();
      } else if (kind === 'select') {
        if (!(el instanceof HTMLSelectElement)) throw new Error('Cet élément n’est pas une liste');
        for (const option of el.options) option.selected = data.values.includes(option.value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }, [selector, action, params]);
  }

  async function execute(type, payload = {}) {
    if (type === 'browser_wait') {
      const time = Number(payload.time);
      if (!Number.isFinite(time) || time < 0 || time > 300) throw new Error('Durée invalide (0–300 s)');
      await new Promise(resolve => setTimeout(resolve, time * 1000));
      return true;
    }
    const tab = await activeTab();
    const tabId = tab.id;
    switch (type) {
      case 'getUrl': return tab.url || '';
      case 'getTitle': return tab.title || '';
      case 'browser_navigate': {
        const url = new URL(payload.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL HTTP(S) requise');
        await chrome.tabs.update(tabId, { url: url.href });
        await waitForLoad(tabId);
        return true;
      }
      case 'browser_go_back':
        await chrome.tabs.goBack(tabId); await waitForLoad(tabId); return true;
      case 'browser_go_forward':
        await chrome.tabs.goForward(tabId); await waitForLoad(tabId); return true;
      case 'browser_snapshot': {
        const entries = await run(tabId, snapshotInPage);
        refs.clear();
        entries.forEach(entry => refs.set(entry.ref, { selector: entry.selector, tabId }));
        return entries.map(entry => `- ${entry.role} "${entry.name}" [ref=${entry.ref}]`).join('\n');
      }
      case 'browser_click':
      case 'browser_hover':
      case 'browser_type':
      case 'browser_select_option': {
        const action = type.slice('browser_'.length);
        await interact(tabId, selectorFor(payload.ref, tabId), action === 'select_option' ? 'select' : action, payload);
        return true;
      }
      case 'browser_drag': {
        const source = selectorFor(payload.startRef, tabId);
        const target = selectorFor(payload.endRef, tabId);
        return run(tabId, (a, b) => {
          const src = document.querySelector(a), dst = document.querySelector(b);
          if (!src || !dst) throw new Error('Élément introuvable');
          const transfer = new DataTransfer();
          src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
          dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
          src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
          return true;
        }, [source, target]);
      }
      case 'browser_press_key':
        return run(tabId, (key) => {
          const target = document.activeElement || document.body;
          target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
          target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
          return true;
        }, [payload.key]);
      case 'browser_screenshot': {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        return dataUrl.slice(dataUrl.indexOf(',') + 1);
      }
      case 'browser_get_console_logs': return consoleLogs.slice();
      default: throw new Error(`Commande inconnue : ${type}`);
    }
  }

  const TYPES = new Set(['getUrl','getTitle','browser_navigate','browser_go_back','browser_go_forward',
    'browser_wait','browser_press_key','browser_snapshot','browser_click','browser_hover',
    'browser_type','browser_select_option','browser_drag','browser_screenshot','browser_get_console_logs']);

  async function handle(message, reply) {
    if (!TYPES.has(message.type)) return false;
    try { reply({ type: 'messageResponse', payload: { requestId: message.id, result: await execute(message.type, message.payload) } }); }
    catch (error) { reply({ type: 'messageResponse', payload: { requestId: message.id, error: error.message } }); }
    return true;
  }

  return { handle, recordConsole };
})();
