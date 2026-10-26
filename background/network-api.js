/** Per-tab CDP network capture. Buffers survive stop, but not extension reload. */
(() => {
  const sessions = new Map();
  const operations = new Map();
  const MAX_BODY = 256 * 1024;
  const MAX_BODY_TOTAL = 8 * 1024 * 1024;
  const clip = value => String(value ?? '').slice(0, MAX_BODY);
  const command = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
  async function tabIdFor(params) {
    if (params.tabId != null) return params.tabId;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error('Aucun onglet actif');
    return tab.id;
  }
  function status(s) {
    return { tabId: s.tabId, capturing: s.capturing, count: s.entries.size, dropped: s.dropped, stoppedReason: s.stoppedReason };
  }
  function trim(s) {
    while (s.entries.size > s.maxEntries) {
      const [id, entry] = s.entries.entries().next().value;
      s.entries.delete(id);
      s.bodyBytes -= (entry.responseBody?.body.length || 0) + (entry.frames || []).reduce((n, f) => n + f.data.length, 0);
      if (s.live.get(entry.requestId) === entry) s.live.delete(entry.requestId);
      s.dropped++;
    }
  }
  function applyResponse(entry, response) {
    entry.response = response;
    entry.status = response.status;
    entry.mimeType = response.mimeType;
    entry.fromCache = !!(entry.fromCache || response.fromDiskCache || response.fromPrefetchCache);
    entry.fromServiceWorker = !!response.fromServiceWorker;
  }
  function track(s, task) {
    s.pending.add(task);
    task.finally(() => s.pending.delete(task)).catch(() => {});
  }
  async function captureBody(s, entry) {
    if (!s.captureBodies || entry.type === 'WebSocket') return;
    try {
      const body = await command(s.tabId, 'Network.getResponseBody', { requestId: entry.requestId });
      if (s.entries.get(entry.id) !== entry) return;
      const available = Math.max(0, Math.min(MAX_BODY, MAX_BODY_TOTAL - s.bodyBytes));
      // A partial base64 payload cannot be decoded as the original resource.
      if (body.base64Encoded && body.body.length > available) {
        entry.bodyError = 'Corps binaire omis : limite de capture atteinte';
        return;
      }
      entry.responseBody = { body: body.body.slice(0, available), base64Encoded: body.base64Encoded, truncated: body.body.length > available };
      s.bodyBytes += entry.responseBody.body.length;
    } catch (error) { entry.bodyError = error.message; }
  }
  function onEvent(source, method, p) {
    if (source.sessionId) return;
    const s = sessions.get(source.tabId);
    if (!s?.capturing || !method.startsWith('Network.')) return;
    let entry = s.live.get(p.requestId);
    if (method === 'Network.requestWillBeSent' || method === 'Network.webSocketCreated') {
      if (p.redirectResponse && entry) {
        applyResponse(entry, p.redirectResponse);
        entry.durationMs = Math.max(0, (p.timestamp - entry.timestamp) * 1000);
        entry.finished = true;
      }
      entry = {
        id: `${p.requestId}:${++s.sequence}`, requestId: p.requestId,
        url: p.request?.url || p.url, method: p.request?.method || 'GET',
        requestHeaders: p.request?.headers || {}, postData: p.request?.postData == null ? undefined : clip(p.request.postData).slice(0, 16384),
        postDataTruncated: (p.request?.postData?.length || 0) > 16384,
        type: p.type || 'WebSocket', timestamp: p.timestamp,
        startedDateTime: new Date((p.wallTime || Date.now() / 1000) * 1000).toISOString(),
        initiator: p.initiator, finished: false,
      };
      s.entries.set(entry.id, entry);
      s.live.set(p.requestId, entry);
      trim(s);
      return;
    }
    if (!entry) return;
    switch (method) {
      case 'Network.requestWillBeSentExtraInfo': entry.requestHeaders = p.headers; break;
      case 'Network.responseReceived': applyResponse(entry, p.response); entry.type = p.type || entry.type; break;
      case 'Network.responseReceivedExtraInfo':
        entry.responseHeaders = p.headers; entry.status = p.statusCode; break;
      case 'Network.requestServedFromCache': entry.fromCache = true; break;
      case 'Network.loadingFinished':
        entry.finished = true;
        entry.durationMs = Math.max(0, (p.timestamp - entry.timestamp) * 1000);
        entry.encodedDataLength = p.encodedDataLength;
        track(s, captureBody(s, entry));
        break;
      case 'Network.loadingFailed':
        entry.finished = true;
        entry.durationMs = Math.max(0, (p.timestamp - entry.timestamp) * 1000);
        entry.error = { message: p.errorText, canceled: p.canceled, blockedReason: p.blockedReason, corsErrorStatus: p.corsErrorStatus };
        break;
      case 'Network.webSocketWillSendHandshakeRequest': entry.requestHeaders = p.request.headers; break;
      case 'Network.webSocketHandshakeResponseReceived': applyResponse(entry, p.response); break;
      case 'Network.webSocketFrameSent':
      case 'Network.webSocketFrameReceived': {
        entry.frames ||= [];
        const frame = p.response;
        const remaining = Math.max(0, MAX_BODY_TOTAL - s.bodyBytes);
        const data = String(frame.payloadData || '').slice(0, Math.min(16384, remaining));
        entry.frames.push({ direction: method.endsWith('Sent') ? 'sent' : 'received', timestamp: p.timestamp, opcode: frame.opcode, data, truncated: data.length < (frame.payloadData || '').length });
        s.bodyBytes += data.length;
        if (entry.frames.length > 100) s.bodyBytes -= entry.frames.shift().data.length;
        break;
      }
      case 'Network.webSocketClosed': entry.finished = true; break;
      case 'Network.webSocketFrameError': entry.error = { message: p.errorMessage }; break;
    }
  }
  async function stop(s) {
    if (!s.capturing) return status(s);
    s.capturing = false;
    await Promise.allSettled([...s.pending]);
    try { await command(s.tabId, 'Network.disable'); }
    finally { await self.BrowserMcpDebugger.release(s.tabId); }
    return status(s);
  }
  const headers = values => Object.entries(values || {}).flatMap(([name, value]) => String(value).split('\n').map(value => ({ name, value })));
  function har(s) {
    return { log: { version: '1.2', creator: { name: 'BrowserMCP Extended', version: '2.0.0' }, entries: [...s.entries.values()].map(e => {
      const requestHeaders = headers(e.requestHeaders);
      const responseHeaders = headers(e.responseHeaders || e.response?.headers);
      const body = e.responseBody;
      let queryString = [];
      try { queryString = [...new URL(e.url).searchParams].map(([name, value]) => ({ name, value })); } catch {}
      const time = e.durationMs || 0;
      return {
        startedDateTime: e.startedDateTime, time,
        request: { method: e.method, url: e.url, httpVersion: e.response?.protocol || '', headers: requestHeaders, cookies: [], queryString, headersSize: -1, bodySize: -1,
          ...(e.postData != null ? { postData: { mimeType: requestHeaders.find(h => h.name.toLowerCase() === 'content-type')?.value || '', text: e.postData } } : {}) },
        response: { status: e.status || 0, statusText: e.response?.statusText || '', httpVersion: e.response?.protocol || '', headers: responseHeaders, cookies: [], headersSize: -1, bodySize: e.encodedDataLength ?? -1, redirectURL: responseHeaders.find(h => h.name.toLowerCase() === 'location')?.value || '',
          content: { size: body ? (body.base64Encoded ? Math.max(0, Math.floor(body.body.length * 3 / 4) - (body.body.match(/=+$/)?.[0].length || 0)) : new TextEncoder().encode(body.body).length) : Math.max(0, e.encodedDataLength || 0), _sizeEstimated: !body || body.truncated, mimeType: e.mimeType || '', ...(body ? { text: body.body, ...(body.base64Encoded ? { encoding: 'base64' } : {}), ...(body.truncated ? { _truncated: true } : {}) } : {}) } },
        cache: {}, timings: { send: 0, wait: time, receive: 0 },
        _id: e.id, _error: e.error, _bodyError: e.bodyError, _webSocketFrames: e.frames,
      };
    }) } };
  }
  self.BrowserMcpNetwork = {
    async handle(action, params = {}) {
      const tabId = await tabIdFor(params);
      const task = (operations.get(tabId) || Promise.resolve()).catch(() => {}).then(() => this.execute(action, { ...params, tabId }));
      operations.set(tabId, task);
      task.finally(() => { if (operations.get(tabId) === task) operations.delete(tabId); }).catch(() => {});
      return task;
    },
    async execute(action, params = {}) {
      const tabId = await tabIdFor(params);
      let s = sessions.get(tabId);
      if (action === 'start') {
        if (s?.capturing) return status(s);
        await self.BrowserMcpDebugger.acquire(tabId);
        s = { tabId, capturing: true, entries: new Map(), live: new Map(), pending: new Set(), bodyBytes: 0, sequence: 0, dropped: 0, maxEntries: params.maxEntries || 1000, captureBodies: params.captureBodies !== false };
        sessions.set(tabId, s);
        try {
          await command(tabId, 'Network.enable', { maxTotalBufferSize: 16 * 1024 * 1024, maxResourceBufferSize: MAX_BODY, maxPostDataSize: MAX_BODY });
        } catch (error) { s.capturing = false; await self.BrowserMcpDebugger.release(tabId); throw error; }
        return status(s);
      }
      if (!s) throw new Error(`Aucune capture pour l’onglet ${tabId}. Lancez browser_network_start.`);
      if (action === 'stop') return stop(s);
      if (action === 'clear') {
        s.entries.clear(); s.live.clear(); s.bodyBytes = 0; s.dropped = 0;
        return status(s);
      }
      if (action === 'exportHar') {
        await Promise.allSettled([...s.pending]);
        return har(s);
      }
      if (action === 'detail') {
        const entry = s.entries.get(params.requestId);
        if (!entry) throw new Error('Requête introuvable ou supprimée du tampon');
        await Promise.allSettled([...s.pending]);
        return entry;
      }
      if (action === 'list') {
        const entries = [...s.entries.values()].filter(e =>
          (!params.url || e.url.includes(params.url)) &&
          (!params.method || e.method.toUpperCase() === params.method.toUpperCase()) &&
          (params.status == null || e.status === params.status) &&
          (!params.resourceType || e.type.toLowerCase() === params.resourceType.toLowerCase()));
        return { ...status(s), total: entries.length, offset: params.offset || 0, requests: entries.slice(params.offset || 0, (params.offset || 0) + (params.limit || 100)).map(e => ({ id: e.id, url: e.url, method: e.method, type: e.type, status: e.status, durationMs: e.durationMs, finished: e.finished, error: e.error, fromCache: e.fromCache })) };
      }
      throw new Error(`Action réseau inconnue : ${action}`);
    },
    async stopAll() {
      await Promise.allSettled([...operations.values()]);
      await Promise.allSettled([...sessions.values()].map(stop));
    },
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach?.addListener(({ tabId }, reason) => {
    const s = sessions.get(tabId);
    if (s?.capturing) { s.capturing = false; s.stoppedReason = reason; }
  });
  chrome.tabs.onRemoved?.addListener(tabId => sessions.delete(tabId));
})();
