const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('background/legacy-api.js', 'utf8');
function boot() {
  const calls = [];
  const chrome = {
    tabs: {
      async query() { return [{ id: 7, url: 'https://example.com', title: 'Example', windowId: 1 }]; },
      async update(id, value) { calls.push(['update', id, value]); },
      async captureVisibleTab() { return 'data:image/png;base64,abc'; },
    },
    scripting: {
      async executeScript({ target, args, func }) {
        calls.push(['script', target, args]);
        if (func.name === 'snapshotInPage') return [{ result: [{ ref: 'e1', selector: '#submit', role: 'button', name: 'Envoyer' }] }];
        return [{ result: true }];
      },
    },
  };
  const self = {};
  vm.runInNewContext(source, { self, chrome, URL, setTimeout });
  const send = async (type, payload = {}) => {
    let reply;
    const handled = await self.BrowserMcpLegacy.handle({ id: 'r1', type, payload }, value => { reply = value; });
    return { handled, reply };
  };
  return { send, calls };
}
test('legacy requests use the shared channel response format', async () => {
  const app = boot();
  const { reply } = await app.send('getUrl');
  assert.equal(reply.type, 'messageResponse');
  assert.equal(reply.payload.requestId, 'r1');
  assert.equal(reply.payload.result, 'https://example.com');
});
test('snapshot references resolve to an element and expire when absent', async () => {
  const app = boot();
  assert.match((await app.send('browser_snapshot')).reply.payload.result, /ref=e1/);
  assert.equal((await app.send('browser_click', { ref: 'e1' })).reply.payload.result, true);
  assert.equal(app.calls.at(-1)[2][0], '#submit');
  assert.match((await app.send('browser_click', { ref: 'e2' })).reply.payload.error, /expirée/);
});
test('navigation rejects non-http URLs and screenshot returns PNG data', async () => {
  const app = boot();
  assert.match((await app.send('browser_navigate', { url: 'file:///tmp/test' })).reply.payload.error, /HTTP/);
  assert.equal((await app.send('browser_screenshot')).reply.payload.result, 'abc');
});
