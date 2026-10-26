const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('background/execute-script-api.js', 'utf8');
async function boot(stored = {}) {
  let listener, alarm, fail = false, networkStops = 0;
  const sockets = [], timers = new Map();
  class Socket {
    static CONNECTING = 0; static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
    send() {}
  }
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, sendMessage() {} },
    storage: { local: { async get() { return stored; }, async set(data) { if (fail) throw Error('storage'); Object.assign(stored, data); } } },
    alarms: { create() {}, onAlarm: { addListener(fn) { alarm = fn; } } },
  };
  vm.runInNewContext(source, { self: { BrowserMcpNetwork: { async stopAll() { networkStops++; } } }, chrome, WebSocket: Socket, console, setTimeout(fn) { const id = {}; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); }, setInterval() {} });
  await new Promise(setImmediate);
  return { sockets, stored, timers, get networkStops() { return networkStops; }, failStorage() { fail = true; }, alarm() { alarm({ name: 'browsermcp-execute-ws' }); }, send(message) { return new Promise(resolve => listener(message, {}, resolve)); } };
}
test('OFF persists at startup and blocks alarms and runtime execution', async () => {
  const app = await boot({ mcpEnabled: false });
  app.alarm();
  assert.equal(app.sockets.length, 0);
  assert.equal((await app.send({ type: 'getWsStatus' })).enabled, false);
  assert.equal((await app.send({ type: 'executeScript', code: '1' })).__ok, false);
});
test('switch closes socket, cancels reconnect and reconnects on activation', async () => {
  const app = await boot();
  app.sockets[0].close();
  assert.equal(app.timers.size, 1);
  await app.send({ type: 'setEnabled', enabled: false });
  assert.equal(app.timers.size, 0);
  assert.equal(app.networkStops, 1);
  app.alarm();
  assert.equal(app.sockets.length, 1);
  await app.send({ type: 'setEnabled', enabled: true });
  assert.equal(app.sockets.length, 2);
  assert.equal(app.stored.mcpEnabled, true);
});
test('settings persist without reactivating OFF; invalid settings are rejected', async () => {
  const app = await boot({ mcpEnabled: false });
  assert.equal((await app.send({ type: 'applySettings', port: 9999, timeout: 20000 })).ok, true);
  assert.equal(app.sockets.length, 0);
  await app.send({ type: 'setEnabled', enabled: true });
  assert.equal(app.sockets[0].url, 'ws://127.0.0.1:9999');
  assert.equal((await app.send({ type: 'applySettings', port: 70000, timeout: 20000 })).ok, false);
});
test('old close events cannot erase a replacement connection', async () => {
  const app = await boot();
  const oldClose = app.sockets[0].onclose;
  await app.send({ type: 'applySettings', port: 9998, timeout: 15000 });
  oldClose();
  assert.equal((await app.send({ type: 'getWsStatus' })).connecting, true);
  assert.equal(app.timers.size, 0);
});
test('storage failure is reported without changing activation', async () => {
  const app = await boot();
  app.failStorage();
  assert.equal((await app.send({ type: 'setEnabled', enabled: false })).ok, false);
  assert.equal((await app.send({ type: 'getWsStatus' })).enabled, true);
});
test('previous default port migrates once and explicit port remains available', async () => {
  const migrated = await boot({ wsPort: 9876 });
  assert.equal(migrated.sockets[0].url, 'ws://127.0.0.1:9877');
  assert.equal(migrated.stored.wsPort, 9877);
  const explicit = await boot({ wsPort: 9876, wsPortMigratedV2: true });
  assert.equal(explicit.sockets[0].url, 'ws://127.0.0.1:9876');
});
