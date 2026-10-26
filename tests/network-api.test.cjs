const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function boot() {
  const events = [], detaches = [], calls = [];
  let body = { body: '{"ok":true}', base64Encoded: false };
  const chrome = {
    tabs: { async query() { return [{ id: 7 }]; }, onRemoved: { addListener() {} } },
    debugger: {
      onEvent: { addListener(fn) { events.push(fn); } },
      onDetach: { addListener(fn) { detaches.push(fn); } },
      async attach() { calls.push('attach'); }, async detach() { calls.push('detach'); },
      async sendCommand(target, method) { calls.push(method); if (method === 'Network.getResponseBody') return body; return {}; },
    },
  };
  const context = vm.createContext({ self: {}, chrome, console, URL, TextEncoder });
  for (const file of ['debugger-session.js', 'network-api.js']) vm.runInContext(fs.readFileSync('background/' + file, 'utf8'), context);
  const api = context.self.BrowserMcpNetwork;
  const event = (method, params) => events.forEach(fn => fn({ tabId: 7 }, 'Network.' + method, params));
  const request = (id, extra = {}) => event('requestWillBeSent', { requestId: id, timestamp: 10, wallTime: 1700000000, type: 'Fetch', request: { url: 'https://test.local/api?q=one', method: 'POST', headers: { 'Content-Type': 'application/json' }, postData: '{"hello":1}' }, ...extra });
  return { api, calls, request, event, detach: () => detaches.forEach(fn => fn({ tabId: 7 }, 'canceled_by_user')), setBody(value) { body = value; }, debugger: context.self.BrowserMcpDebugger };
}
test('captures body, filters requests and exports HAR after stop', async () => {
  const b = boot();
  await b.api.handle('start');
  b.request('r1');
  b.event('responseReceived', { requestId: 'r1', type: 'Fetch', response: { status: 201, statusText: 'Created', mimeType: 'application/json', headers: {}, protocol: 'h2' } });
  b.event('loadingFinished', { requestId: 'r1', timestamp: 10.25, encodedDataLength: 40 });
  await b.api.handle('stop');
  const list = await b.api.handle('list', { status: 201, method: 'post', url: '/api', resourceType: 'fetch' });
  assert.equal(list.total, 1);
  const detail = await b.api.handle('detail', { requestId: list.requests[0].id });
  assert.equal(detail.responseBody.body, '{"ok":true}');
  assert.equal(detail.durationMs, 250);
  const har = await b.api.handle('exportHar');
  assert.equal(har.log.version, '1.2');
  assert.equal(har.log.entries[0].request.queryString[0].value, 'one');
  assert.equal(har.log.entries[0].response.status, 201);
  assert.equal(har.log.entries[0].response.content.size, 11);
  assert.equal(b.calls.filter(x => x === 'detach').length, 1);
});
test('redirection keeps separate records and failures remain inspectable', async () => {
  const b = boot(); await b.api.handle('start');
  b.request('r');
  b.request('r', { timestamp: 10.1, redirectResponse: { status: 302, headers: { location: '/next' } } });
  b.event('loadingFailed', { requestId: 'r', timestamp: 10.2, errorText: 'net::ERR_FAILED' });
  const list = await b.api.handle('list');
  assert.equal(list.total, 2);
  assert.notEqual(list.requests[0].id, list.requests[1].id);
  assert.equal(list.requests[0].status, 302);
  assert.equal(list.requests[1].error.message, 'net::ERR_FAILED');
});
test('bounded records, body truncation and clear ignore obsolete pending bodies', async () => {
  const b = boot(); await b.api.handle('start', { maxEntries: 1 });
  b.request('old'); b.request('new');
  b.setBody({ body: 'a'.repeat(300000), base64Encoded: false });
  b.event('loadingFinished', { requestId: 'new', timestamp: 11, encodedDataLength: 300000 });
  const list = await b.api.handle('list');
  assert.equal(list.dropped, 1);
  const detail = await b.api.handle('detail', { requestId: list.requests[0].id });
  assert.equal(detail.responseBody.truncated, true);
  assert.equal(detail.responseBody.body.length, 256 * 1024);
  await b.api.handle('clear');
  assert.equal((await b.api.handle('list')).total, 0);
});
test('websocket messages are retained with directions and bounded frame count', async () => {
  const b = boot(); await b.api.handle('start');
  b.event('webSocketCreated', { requestId: 'ws', url: 'wss://test.local/socket' });
  for (let i = 0; i < 110; i++) b.event('webSocketFrameReceived', { requestId: 'ws', timestamp: i, response: { opcode: 1, payloadData: 'hello' } });
  const list = await b.api.handle('list', { resourceType: 'WebSocket' });
  const detail = await b.api.handle('detail', { requestId: list.requests[0].id });
  assert.equal(detail.frames.length, 100);
  assert.equal(detail.frames[0].direction, 'received');
});
test('temporary operations keep capture attached; stopAll releases it; external detach updates state', async () => {
  const b = boot(); await b.api.handle('start');
  await b.debugger.acquire(7); await b.debugger.release(7);
  assert.equal(b.calls.includes('detach'), false);
  await b.api.stopAll();
  assert.equal((await b.api.handle('list')).capturing, false);
  assert.equal(b.calls.includes('detach'), true);
  await b.api.handle('start'); b.detach();
  assert.equal((await b.api.handle('list')).stoppedReason, 'canceled_by_user');
});
test('concurrent starts acquire a single capture lease and captureBodies false skips bodies', async () => {
  const b = boot();
  await Promise.all([b.api.handle('start', { captureBodies: false }), b.api.handle('start')]);
  assert.equal(b.calls.filter(x => x === 'attach').length, 1);
  b.request('r'); b.event('loadingFinished', { requestId: 'r', timestamp: 11 });
  await b.api.handle('stop');
  assert.equal(b.calls.includes('Network.getResponseBody'), false);
});
