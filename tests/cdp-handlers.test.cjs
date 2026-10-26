const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('background/execute-script-api.js', 'utf8');
async function boot() {
  const commands = [], events = new Set(), sent = [];
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { this.readyState = 0; socket = this; }
    send(data) { sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  let socket;
  const chrome = {
    storage: { local: { async get() { return {}; } } },
    runtime: { onMessage: { addListener() {} }, sendMessage() {} },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    tabs: { async query() { return [{ id: 3 }]; }, async reload(tabId, options) { commands.push(['tabs.reload', { tabId, ...options }]); } },
    debugger: {
      onEvent: { addListener(fn) { events.add(fn); }, removeListener(fn) { events.delete(fn); } },
      async attach() {}, async detach() {},
      async sendCommand(target, method, params) {
        commands.push([method, params]);
        if (method === 'Runtime.enable') {
          for (const fn of events) fn({ tabId: 3 }, 'Runtime.executionContextCreated', { context: { id: 42, auxData: { isDefault: true, frameId: 'frame-b' } } });
        }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root' }, childFrames: [{ frame: { id: 'frame-b', name: 'checkout' } }] } };
        if (method === 'Runtime.evaluate') return { result: { value: 'from-frame' } };
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 2 };
        if (method === 'DOM.describeNode') return { node: { nodeName: 'INPUT', attributes: ['type', 'file'] } };
        return {};
      },
    },
  };
  const context = vm.createContext({ chrome, WebSocket: Socket, self: { BrowserMcpLegacy: { handle: async () => false } }, console, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync('background/debugger-session.js', 'utf8'), context);
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  socket.readyState = 1;
  const send = async (type, payload) => {
    socket.onmessage({ data: JSON.stringify({ id: 'req', type, payload }) });
    await new Promise(setImmediate);
    return sent.findLast(msg => msg.type === 'messageResponse');
  };
  return { send, commands, events };
}
test('frame execution uses the matched frame context', async () => {
  const app = await boot();
  const reply = await app.send('executeInFrame', { frameId: 'checkout', code: '1+1' });
  assert.equal(reply.payload.result.value, 'from-frame');
  assert.equal(app.commands.find(([name]) => name === 'Runtime.evaluate')[1].contextId, 42);
  assert.equal(app.events.size, 0);
});
test('unknown frame is rejected without evaluating in the top frame', async () => {
  const app = await boot();
  const reply = await app.send('executeInFrame', { frameId: 'missing', code: '1+1' });
  assert.match(reply.payload.error, /Frame introuvable/);
  assert.equal(app.commands.some(([name]) => name === 'Runtime.evaluate'), false);
});
test('upload sends a CDP file assignment to a validated input', async () => {
  const app = await boot();
  const reply = await app.send('setFileInputFiles', { selector: '#upload', filePath: '/tmp/example.txt' });
  assert.equal(reply.payload.result.success, true);
  assert.deepEqual(Array.from(app.commands.find(([name]) => name === 'DOM.setFileInputFiles')[1].files), ['/tmp/example.txt']);
});

test('hard reload uses the Chrome cache bypass option', async () => {
  const app = await boot();
  const reply = await app.send('reload', { hard: true });
  assert.equal(reply.payload.result.success, true);
  const params = app.commands.find(([name]) => name === 'tabs.reload')[1];
  assert.equal(params.tabId, 3);
  assert.equal(params.bypassCache, true);
});
