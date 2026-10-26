/**
 * execute-script-api.js — Background script enrichi de BrowserMCP
 *
 * Extension de l'original v1.3.4 avec :
 *  - Logger de commandes MCP (timestamp, outil, durée, résultat)
 *  - Broadcast du log vers la popup via chrome.runtime.sendMessage
 *  - Handlers WebSocket supplémentaires :
 *      listTabs, switchTab, newTab, closeTab, getStorage,
 *      getCookies, captureFullPage, handleDialog, executeInFrame
 *  - Réponse aux messages chrome.runtime de la popup :
 *      getWsStatus, getActionLog, clearLog, applySettings, disconnect
 */

(function () {
  'use strict';

  /* ───────────────────────── Configuration ───────────────────────── */
  let WS_PORT = 9877;
  let WS_TIMEOUT = 15000;
  const WS_RECONNECT_DELAY = 3000;
  const ALARM_NAME = 'browsermcp-execute-ws';
  const LOG_MAX = 30;

  /* ───────────────────────── État global ───────────────────────── */
  let ws = null;
  let reconnectTimer = null;
  let extensionReady = false;
  let enabled = false;
  let initialized = false;

  /** Historique des actions MCP (max LOG_MAX entrées, plus récent en tête) */
  let actionLog = [];

  /* ─────────────────────── Connexion WebSocket ─────────────────────── */

  /** Ouvre (ou réouvre) la connexion WebSocket vers le serveur MCP. */
  function stopConnection() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const previous = ws;
    ws = null;
    extensionReady = false;
    if (previous) {
      previous.onopen = previous.onmessage = previous.onclose = previous.onerror = null;
      previous.close();
    }
  }

  function connectWebSocket() {
    if (!initialized || !enabled) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(reconnectTimer);
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      ws = socket;
      socket.onopen = () => {
        if (ws !== socket || !enabled) return;
        extensionReady = true;
        sendWs({ type: 'extensionReady' });
      };
      socket.onmessage = (event) => {
        if (ws !== socket || !enabled) return;
        try { handleWsMessage(JSON.parse(event.data)); }
        catch (e) { console.error('[ExecuteScript] Message WS invalide :', e); }
      };
      socket.onclose = () => {
        if (ws !== socket) return;
        extensionReady = false;
        ws = null;
        if (enabled) reconnectTimer = setTimeout(connectWebSocket, WS_RECONNECT_DELAY);
      };
      socket.onerror = () => socket.close();
    } catch {
      if (enabled) reconnectTimer = setTimeout(connectWebSocket, WS_RECONNECT_DELAY);
    }
  }

  /**
   * Envoie un objet JSON sur le WebSocket.
   * @param {Object} data
   * @returns {boolean} true si envoyé, false sinon
   */
  function sendWs(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  /* ─────────────────────── Logger de commandes ─────────────────────── */

  /**
   * Enregistre une action MCP dans l'historique et la diffuse à la popup.
   * @param {string} tool - Nom de l'outil MCP
   * @param {number} startTime - Date.now() avant l'exécution
   * @param {boolean} success
   * @param {string|null} error - Message d'erreur si échec
   */
  function logMcpAction(tool, startTime, success, error = null) {
    const entry = {
      tool,
      timestamp: startTime,
      duration: Date.now() - startTime,
      success,
      error,
    };

    // Garder les LOG_MAX entrées les plus récentes
    actionLog.unshift(entry);
    if (actionLog.length > LOG_MAX) actionLog.length = LOG_MAX;

    // Broadcaster à la popup (non bloquant)
    try {
      chrome.runtime.sendMessage({ type: 'mcpLog', entry });
    } catch {}
  }

  /* ─────────────────────── Routeur de messages WS ─────────────────────── */

  /**
   * Dispatche les messages reçus depuis le serveur MCP vers le bon handler.
   * @param {{ type: string, id: string, payload: Object }} msg
   */
  async function handleWsMessage(msg) {
    if (msg.type === 'networkCapture') {
      const start = Date.now();
      try {
        const result = await self.BrowserMcpNetwork.handle(msg.payload.action, msg.payload);
        sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result } });
        logMcpAction('network.' + msg.payload.action, start, true);
      } catch (error) {
        sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: error.message } });
        logMcpAction('network.' + msg.payload?.action, start, false, error.message);
      }
      return;
    }
    switch (msg.type) {
      case 'executeScript':  handleWsExecute({ id: msg.id, ...(msg.payload || {}) }); break;
      case 'reload': {
        const start = Date.now();
        try {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tab) throw new Error('No active tab');
          await chrome.tabs.reload(tab.id, { bypassCache: msg.payload?.hard === true });
          sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result: { success: true } } });
          logMcpAction('reload', start, true);
        } catch (error) {
          sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: error.message } });
          logMcpAction('reload', start, false, error.message);
        }
        break;
      }
      case 'getActiveTab':   handleWsGetActiveTab(msg); break;
      case 'listTabs':       handleWsListTabs(msg);     break;
      case 'switchTab':      handleWsSwitch(msg);       break;
      case 'newTab':         handleWsNewTab(msg);       break;
      case 'closeTab':       handleWsCloseTab(msg);     break;
      case 'getStorage':     handleWsGetStorage(msg);   break;
      case 'getCookies':     handleWsGetCookies(msg);   break;
      case 'captureFullPage':handleWsCaptureFullPage(msg); break;
      case 'handleDialog':   handleWsHandleDialog(msg); break;
      case 'executeInFrame': handleWsExecuteInFrame(msg); break;
      case 'setFileInputFiles': handleWsSetFileInputFiles(msg); break;
      case 'ping':           sendWs({ type: 'pong' });  break;
      default:
        await self.BrowserMcpLegacy.handle(msg, sendWs);
    }
  }

  /* ─────────────────────── Handler : executeScript ─────────────────────── */

  /**
   * Exécute du JavaScript dans l'onglet actif (ou l'onglet ciblé).
   */
  async function handleWsExecute(msg) {
    const { id, code, captureConsole = true, timeoutMs = WS_TIMEOUT,
            world = 'ISOLATED', tabId, frameId } = msg;
    const start = Date.now();

    try {
      let targetTabId = tabId;
      if (!targetTabId) {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        let validTab = tabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
        if (!validTab) {
          const allTabs = await chrome.tabs.query({});
          validTab = allTabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
        }
        targetTabId = validTab?.id;
      }

      if (!targetTabId) {
        const res = { __ok: false, error: { message: 'No active tab found with an accessible URL' }, __consoleBuffer: [] };
        sendWs({ type: 'messageResponse', payload: { requestId: id, result: res } });
        logMcpAction('executeScript', start, false, 'No active tab');
        return;
      }

      const result = await executeWithTimeout(targetTabId, code, captureConsole !== false, timeoutMs || WS_TIMEOUT, world || 'ISOLATED', frameId);
      self.BrowserMcpLegacy.recordConsole(result.__consoleBuffer);
      sendWs({ type: 'messageResponse', payload: { requestId: id, result } });
      logMcpAction('executeScript', start, result.__ok !== false);
    } catch (e) {
      sendWs({ type: 'messageResponse', payload: { requestId: id, result: { __ok: false, error: { message: e.message, name: e.name }, __consoleBuffer: [] } } });
      logMcpAction('executeScript', start, false, e.message);
    }
  }

  /* ─────────────────────── Handler : getActiveTab ─────────────────────── */

  async function handleWsGetActiveTab(msg) {
    const { id } = msg;
    const start = Date.now();
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      sendWs({
        type: 'getActiveTabResult',
        id,
        result: tab ? { tabId: tab.id, title: tab.title, url: tab.url } : null,
      });
      logMcpAction('getActiveTab', start, true);
    } catch (e) {
      sendWs({ type: 'getActiveTabResult', id, result: null, error: e.message });
      logMcpAction('getActiveTab', start, false, e.message);
    }
  }

  /* ─────────────────────── Handler : listTabs ─────────────────────── */

  /**
   * Retourne la liste de tous les onglets ouverts.
   */
  async function handleWsListTabs(msg) {
    const start = Date.now();
    try {
      const tabs = await chrome.tabs.query({});
      const result = tabs.map(t => ({
        tabId: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        favIconUrl: t.favIconUrl,
      }));
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result } });
      logMcpAction('listTabs', start, true);
    } catch (e) {
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: e.message } });
      logMcpAction('listTabs', start, false, e.message);
    }
  }

  /* ─────────────────────── Handler : switchTab ─────────────────────── */

  /**
   * Active l'onglet spécifié par son ID.
   */
  async function handleWsSwitch(msg) {
    const start = Date.now();
    try {
      await chrome.tabs.update(msg.payload.tabId, { active: true });
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result: { success: true } } });
      logMcpAction('switchTab', start, true);
    } catch (e) {
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: e.message } });
      logMcpAction('switchTab', start, false, e.message);
    }
  }

  /* ─────────────────────── Handler : newTab ─────────────────────── */

  /**
   * Ouvre un nouvel onglet (optionnellement avec une URL).
   */
  async function handleWsNewTab(msg) {
    const start = Date.now();
    try {
      const tab = await chrome.tabs.create({ url: msg.payload?.url || 'about:blank' });
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result: { tabId: tab.id } } });
      logMcpAction('newTab', start, true);
    } catch (e) {
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: e.message } });
      logMcpAction('newTab', start, false, e.message);
    }
  }

  /* ─────────────────────── Handler : closeTab ─────────────────────── */

  /**
   * Ferme un onglet par son ID.
   */
  async function handleWsCloseTab(msg) {
    const start = Date.now();
    try {
      await chrome.tabs.remove(msg.payload.tabId);
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result: { success: true } } });
      logMcpAction('closeTab', start, true);
    } catch (e) {
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: e.message } });
      logMcpAction('closeTab', start, false, e.message);
    }
  }

  /* ─────────────────────── Handler : getStorage ─────────────────────── */

  /**
   * Lit localStorage et sessionStorage de l'onglet actif via executeScript.
   */
  async function handleWsGetStorage(msg) {
    const start = Date.now();
    const code = `JSON.stringify({ local: {...localStorage}, session: {...sessionStorage} })`;
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) throw new Error('No active tab');
      const result = await executeWithTimeout(tabId, code, false, WS_TIMEOUT, 'ISOLATED');
      const parsed = JSON.parse(result.value ?? '{}');
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result: parsed } });
      logMcpAction('getStorage', start, true);
    } catch (e) {
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: e.message } });
      logMcpAction('getStorage', start, false, e.message);
    }
  }

  /* ─────────────────────── Handler : getCookies ─────────────────────── */

  /**
   * Retourne les cookies pour l'URL donnée (nécessite la permission "cookies").
   */
  async function handleWsGetCookies(msg) {
    const start = Date.now();
    try {
      const cookies = await chrome.cookies.getAll({ url: msg.payload?.url || '' });
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result: cookies } });
      logMcpAction('getCookies', start, true);
    } catch (e) {
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: e.message } });
      logMcpAction('getCookies', start, false, e.message);
    }
  }

  /* ─────────────────────── Handler : captureFullPage ─────────────────────── */

  /**
   * Capture une screenshot pleine page (au-delà du viewport) via CDP.
   */
  async function handleWsCaptureFullPage(msg) {
    const start = Date.now();
    let attachedTabId;
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) throw new Error('No active tab');

      await self.BrowserMcpDebugger.acquire(tabId);
      attachedTabId = tabId;

      const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
      });

      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result: { data: result.data } } });
      logMcpAction('captureFullPage', start, true);
    } catch (e) {
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: e.message } });
      logMcpAction('captureFullPage', start, false, e.message);
    } finally {
      if (attachedTabId != null) await self.BrowserMcpDebugger.release(attachedTabId);
    }
  }

  /* ─────────────────────── Handler : handleDialog ─────────────────────── */

  /**
   * Accepte ou rejette une boîte de dialogue JavaScript (alert/confirm/prompt).
   * payload : { action: 'accept'|'dismiss', promptText?: string }
   */
  async function handleWsHandleDialog(msg) {
    const start = Date.now();
    let attachedTabId;
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const tabId = tabs[0]?.id;
      if (!tabId) throw new Error('No active tab');

      await self.BrowserMcpDebugger.acquire(tabId);
      attachedTabId = tabId;

      await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
        accept: msg.payload?.action !== 'dismiss',
        promptText: msg.payload?.promptText || '',
      });

      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result: { success: true } } });
      logMcpAction('handleDialog', start, true);
    } catch (e) {
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: e.message } });
      logMcpAction('handleDialog', start, false, e.message);
    } finally {
      if (attachedTabId != null) await self.BrowserMcpDebugger.release(attachedTabId);
    }
  }

  /* ─────────────────────── Handler : executeInFrame ─────────────────────── */

  /**
   * Exécute du code JavaScript dans une frame spécifique via CDP Runtime.evaluate.
   * payload : { frameId: string, code: string }
   */
  async function handleWsExecuteInFrame(msg) {
    const start = Date.now();
    const { frameId, code } = msg.payload || {};
    let tabId;
    let attached = false;
    const contexts = new Map();
    const onContext = (source, method, params) => {
      if (source.tabId === tabId && method === 'Runtime.executionContextCreated') {
        const context = params.context;
        if (context.auxData?.isDefault && context.auxData.frameId) {
          contexts.set(context.auxData.frameId, context.id);
        }
      }
    };
    try {
      if (typeof frameId !== 'string' || !frameId || typeof code !== 'string' || !code) {
        throw new Error('frameId et code sont requis');
      }
      tabId = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
      if (!tabId) throw new Error('Aucun onglet actif');
      await self.BrowserMcpDebugger.acquire(tabId);
      attached = true;
      chrome.debugger.onEvent.addListener(onContext);
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
      const { frameTree } = await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree');
      const frames = flattenFrameTree(frameTree).slice(1);
      let target = frames.find(item => item.frame.id === frameId || item.frame.name === frameId);
      if (!target) {
        for (const item of frames) {
          try {
            const owner = await chrome.debugger.sendCommand({ tabId }, 'DOM.getFrameOwner', { frameId: item.frame.id });
            const { node } = await chrome.debugger.sendCommand({ tabId }, 'DOM.describeNode', { nodeId: owner.nodeId });
            const attrs = node.attributes || [];
            if (attrs.some((value, index) => index % 2 === 0 && ['id', 'name'].includes(value) && attrs[index + 1] === frameId)) {
              target = item;
              break;
            }
          } catch {}
        }
      }
      if (!target) throw new Error(`Frame introuvable : ${frameId}`);
      let contextId = contexts.get(target.frame.id);
      for (let attempt = 0; !contextId && attempt < 10; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        contextId = contexts.get(target.frame.id);
      }
      if (!contextId) throw new Error(`Contexte de la frame indisponible : ${frameId}`);
      const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `(async()=>eval(${JSON.stringify(code)}))()`,
        contextId,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Erreur dans la frame');
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result: { __ok: true, value: result.result?.value } } });
      logMcpAction('executeInFrame', start, true);
    } catch (e) {
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: e.message } });
      logMcpAction('executeInFrame', start, false, e.message);
    } finally {
      chrome.debugger.onEvent.removeListener(onContext);
      if (attached) try { await self.BrowserMcpDebugger.release(tabId); } catch {}
    }
  }

  async function handleWsSetFileInputFiles(msg) {
    const start = Date.now();
    const { selector, filePath } = msg.payload || {};
    let tabId;
    let attached = false;
    try {
      if (typeof selector !== 'string' || !selector || typeof filePath !== 'string' || !filePath) {
        throw new Error('Sélecteur et chemin de fichier requis');
      }
      tabId = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
      if (!tabId) throw new Error('Aucun onglet actif');
      await self.BrowserMcpDebugger.acquire(tabId);
      attached = true;
      const { root } = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument', { depth: -1 });
      const { nodeId } = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`Champ introuvable : ${selector}`);
      const { node } = await chrome.debugger.sendCommand({ tabId }, 'DOM.describeNode', { nodeId });
      const attributes = node.attributes || [];
      const typeIndex = attributes.findIndex((value, index) => index % 2 === 0 && value.toLowerCase() === 'type');
      if (node.nodeName !== 'INPUT' || typeIndex < 0 || attributes[typeIndex + 1].toLowerCase() !== 'file') {
        throw new Error('Le sélecteur ne désigne pas un champ de fichier');
      }
      await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { files: [filePath], nodeId });
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, result: { success: true } } });
      logMcpAction('setFileInputFiles', start, true);
    } catch (e) {
      sendWs({ type: 'messageResponse', payload: { requestId: msg.id, error: e.message } });
      logMcpAction('setFileInputFiles', start, false, e.message);
    } finally {
      if (attached) try { await self.BrowserMcpDebugger.release(tabId); } catch {}
    }
  }

  /**
   * Aplatit l'arbre des frames CDP en un tableau plat.
   * @param {Object} node
   * @returns {Array}
   */
  function flattenFrameTree(node) {
    const result = [node];
    if (node.childFrames) {
      for (const child of node.childFrames) {
        result.push(...flattenFrameTree(child));
      }
    }
    return result;
  }

  /* ─────────────────────── Runtime messages (popup) ─────────────────────── */

  /**
   * Répond aux messages envoyés par la popup ou d'autres parties de l'extension.
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return false;

    switch (message.action ?? message.type) {
      // Héritage de l'original : exécution depuis une autre partie de l'extension
      case 'executeScript':
        if (!initialized || !enabled) {
          sendResponse({ __ok: false, error: { message: 'Automatisation désactivée' } });
          return false;
        }
        handleRuntimeExecute(message, sender, sendResponse);
        return true; // réponse asynchrone

      // Statut WebSocket pour la popup
      case 'getWsStatus':
        sendResponse({ enabled, initialized, connected: ws !== null && ws.readyState === WebSocket.OPEN, connecting: ws !== null && ws.readyState === WebSocket.CONNECTING });
        return false;

      // Historique des actions MCP
      case 'getActionLog':
        sendResponse({ log: actionLog });
        return false;

      // Effacer le log
      case 'clearLog':
        actionLog = [];
        sendResponse({ ok: true });
        return false;

      // Appliquer les nouveaux settings (port, timeout)
      case 'applySettings':
        if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535 ||
            !Number.isInteger(message.timeout) || message.timeout < 1000 || message.timeout > 300000) {
          sendResponse({ ok: false, error: 'Port ou délai invalide.' });
          return false;
        }
        ready.then(() => chrome.storage.local.set({ wsPort: message.port, wsTimeout: message.timeout, wsPortMigratedV2: true }))
          .then(() => { applyNewSettings(message.port, message.timeout); sendResponse({ ok: true }); })
          .catch(() => sendResponse({ ok: false, error: 'Enregistrement impossible.' }));
        return true;

      case 'setEnabled':
      case 'disconnect': {
        const value = message.type === 'disconnect' ? false : message.enabled;
        if (typeof value !== 'boolean') return false;
        ready.then(() => chrome.storage.local.set({ mcpEnabled: value })).then(async () => {
          enabled = value;
          if (!enabled) await self.BrowserMcpNetwork?.stopAll();
          if (enabled) connectWebSocket(); else stopConnection();
          sendResponse({ ok: true, enabled });
        }).catch(() => sendResponse({ ok: false, error: 'Modification impossible.' }));
        return true;
      }
    }

    return false;
  });

  /**
   * Applique les nouveaux settings de port/timeout et reconnecte si nécessaire.
   * @param {number} port
   * @param {number} timeout
   */
  function applyNewSettings(port, timeout) {
    if (port && port !== WS_PORT) {
      WS_PORT = port;
      // Fermer et reconnecter avec le nouveau port
      stopConnection();
      connectWebSocket();
    }
    if (timeout) WS_TIMEOUT = timeout;
  }

  /* ─────────────────────── Runtime execute (héritage) ─────────────────────── */

  async function handleRuntimeExecute(message, sender, sendResponse) {
    const { code, captureConsole = true, timeoutMs = WS_TIMEOUT, world = 'ISOLATED' } = message;
    const tabId = message.tabId || sender.tab?.id;

    if (!tabId) {
      sendResponse({ __ok: false, error: { message: 'No tabId specified and no sender tab found' } });
      return;
    }
    if (!code || typeof code !== 'string') {
      sendResponse({ __ok: false, error: { message: 'No code provided' } });
      return;
    }

    try {
      const result = await executeWithTimeout(tabId, code, captureConsole !== false, timeoutMs || WS_TIMEOUT, world || 'ISOLATED', message.frameId);
      sendResponse(result);
    } catch (e) {
      sendResponse({ __ok: false, error: { message: e.message, stack: e.stack, name: e.name, __consoleBuffer: [] } });
    }
  }

  /* ─────────────────────── Exécution de script via CDP ─────────────────────── */

  /**
   * Lance l'exécution avec un timeout de sécurité.
   */
  async function executeWithTimeout(tabId, code, captureConsole, timeoutMs, world, frameId) {
    const execPromise = injectAndExecute(tabId, code, captureConsole, world, frameId);
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Script execution timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return await Promise.race([execPromise, timeoutPromise]);
  }

  /**
   * Attache le débogueur CDP, exécute le code et détache.
   */
  async function injectAndExecute(tabId, code, captureConsole, world, frameId) {
    await self.BrowserMcpDebugger.acquire(tabId);

    const consoleBuffer = [];
    let consoleListener = null;

    try {
      if (captureConsole) {
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable');
        consoleListener = (source, method, params) => {
          if (source.tabId !== tabId) return;
          if (method === 'Runtime.consoleAPICalled') {
            const { type, args, timestamp } = params;
            const text = args
              .map(a => {
                if (a.value !== undefined) return String(a.value);
                if (a.description) return a.description;
                try { return JSON.stringify(a); } catch { return String(a); }
              })
              .join(' ');
            consoleBuffer.push({ level: type, text, timestamp: timestamp * 1000 });
          }
        };
        chrome.debugger.onEvent.addListener(consoleListener);
      }

      const wrappedCode = `(async()=>eval(${JSON.stringify(code)}))()`;
      const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: wrappedCode,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });

      if (result.exceptionDetails || result.wasThrown) {
        return {
          __ok: false,
          error: {
            message: result.exceptionDetails?.text || result.exceptionDetails?.exception?.description || 'Unknown error',
            stack: result.exceptionDetails?.stackTrace?.callFrames
              ?.map(f => `${f.functionName || ''}@${f.url}:${f.lineNumber}:${f.columnNumber}`).join('\n'),
          },
          __consoleBuffer: consoleBuffer,
        };
      }

      return {
        __ok: true,
        value: result.result?.value,
        __consoleBuffer: consoleBuffer,
      };
    } catch (e) {
      return {
        __ok: false,
        error: { message: e.message, stack: e.stack, name: e.name },
        __consoleBuffer: consoleBuffer,
      };
    } finally {
      if (consoleListener) chrome.debugger.onEvent.removeListener(consoleListener);
      if (captureConsole) {
        try { await chrome.debugger.sendCommand({ tabId }, 'Runtime.disable'); } catch {}
      }
      try { await self.BrowserMcpDebugger.release(tabId); } catch {}
    }
  }

  /* ─────────────────────── Keepalive du service worker ─────────────────────── */

  /** Maintient le service worker actif via des alarmes périodiques. */
  function setupKeepalive() {
    try {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.3 });
      chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === ALARM_NAME) {
          if (!extensionReady || !ws || ws.readyState !== WebSocket.OPEN) {
            connectWebSocket();
          }
        }
      });
    } catch (e) {
      // Fallback si l'API alarms n'est pas disponible
      setInterval(() => {
        if (!extensionReady || !ws || ws.readyState !== WebSocket.OPEN) {
          connectWebSocket();
        }
      }, 20000);
    }
  }

  /* ─────────────────────── Démarrage ─────────────────────── */
  const ready = chrome.storage.local.get(['mcpEnabled', 'wsPort', 'wsTimeout', 'wsPortMigratedV2']).then(async (stored) => {
    enabled = stored.mcpEnabled !== false;
    if (stored.wsPort === 9876 && !stored.wsPortMigratedV2) {
      WS_PORT = 9877;
      try {
        await chrome.storage.local.set({ wsPort: WS_PORT, wsPortMigratedV2: true });
      } catch (error) {
        console.error('[BrowserMCP] Migration du port impossible', error);
      }
    } else if (Number.isInteger(stored.wsPort) && stored.wsPort > 0 && stored.wsPort <= 65535) {
      WS_PORT = stored.wsPort;
    }
    if (Number.isInteger(stored.wsTimeout) && stored.wsTimeout >= 1000 && stored.wsTimeout <= 300000) WS_TIMEOUT = stored.wsTimeout;
    initialized = true;
    connectWebSocket();
  });
  ready.catch((error) => console.error('[BrowserMCP] Chargement impossible', error));
  setupKeepalive();
})();
