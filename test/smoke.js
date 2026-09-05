'use strict';

// Ad-hoc smoke test: loads src/main.js directly (no webpack/babel needed since
// it only uses plain modern JS) against a mocked socket, to sanity check the
// away-state / private-message logic without needing a real AirDC++ instance.

const assert = require('assert');
const http = require('http');

let sentNotifications = [];
let listeners = {};

// Minimal fake Gotify server so we can assert on the real HTTP POST
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    sentNotifications.push({
      path: req.url,
      headers: req.headers,
      body: JSON.parse(body),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 1 }));
  });
});

// Simulates the server-side settings store: definitions posted by the extension
// define the defaults; GET returns current effective values (defaults + overrides).
let settingDefinitions = [];
let settingOverrides = {};

const socket = {
  logger: { warn: (...a) => console.log('[warn]', ...a), error: (...a) => console.log('[error]', ...a), info: () => {}, verbose: () => {} },
  get: async (path) => {
    if (path === 'system/away') return { id: 'manual' };
    if (/^extensions\/.+\/settings$/.test(path)) {
      const values = {};
      settingDefinitions.forEach(def => { values[def.key] = def.default_value; });
      Object.assign(values, settingOverrides);
      return values;
    }
    throw new Error(`Unexpected GET ${path}`);
  },
  post: async (path, data) => {
    if (/^extensions\/.+\/settings\/definitions$/.test(path)) {
      settingDefinitions = data;
      return {};
    }
    return {};
  },
  put: async () => ({}),
  patch: async (path, data) => {
    if (/^extensions\/.+\/settings$/.test(path)) {
      Object.assign(settingOverrides, data);
      return {};
    }
    return {};
  },
  delete: async () => ({}),
  addListener: async (section, name, cb) => {
    listeners[`${section}/${name}`] = cb;
    return () => { delete listeners[`${section}/${name}`]; };
  },
};

// airdcpp-extension-settings persists to a config file; point it at a throwaway path
const os = require('os');
const path = require('path');
const fs = require('fs');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airdcpp-ext-test-'));

const extension = {
  name: 'airdcpp-away-gotify-notifier',
  configPath: tmpDir + path.sep,
};

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const factory = require('../src/main.js');
  factory(socket, extension);

  // Simulate the user having configured the extension's settings (this is
  // what the mocked "server" would report back via GET .../settings)
  Object.assign(settingOverrides, {
    gotify_url: `http://127.0.0.1:${port}`,
    gotify_token: 'test-token',
    gotify_priority: 7,
    notify_idle_away: true,
    include_message_text: true,
  });

  listeners = {};
  await extension.onStart({
    system_info: { api_feature_level: 3, cid: 'MYOWNCID000000000000000000000000000000' },
  });

  assert(listeners['system/away_state'], 'away_state listener should be registered');
  assert(listeners['private_chat/private_chat_message'], 'private_chat_message listener should be registered');

  // 1) Away (manual) + message from someone else -> should notify
  await listeners['private_chat/private_chat_message']({
    text: 'hello there',
    from: { nick: 'Alice', cid: 'OTHERCID0000000000000000000000000000000' },
  });

  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 1, 'expected exactly one notification while away');
  assert.strictEqual(sentNotifications[0].headers['x-gotify-key'], 'test-token');
  assert.strictEqual(sentNotifications[0].body.title, 'PM from Alice');
  assert.strictEqual(sentNotifications[0].body.message, 'hello there');
  assert.strictEqual(sentNotifications[0].body.priority, 7);
  console.log('OK: notified for incoming PM while away');

  // 2) Message that is actually from ourselves (echo) -> should NOT notify again
  await listeners['private_chat/private_chat_message']({
    text: 'my own outgoing message',
    from: { nick: 'Me', cid: 'MYOWNCID000000000000000000000000000000' },
  });
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 1, 'should not notify for our own outgoing messages');
  console.log('OK: ignored our own outgoing message');

  // 3) Go back online (away_state -> off) -> should NOT notify
  listeners['system/away_state']({ id: 'off' });
  await listeners['private_chat/private_chat_message']({
    text: 'hi again',
    from: { nick: 'Alice', cid: 'OTHERCID0000000000000000000000000000000' },
  });
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 1, 'should not notify while not away');
  console.log('OK: no notification while away mode is off');

  // 4) Idle away, but notify_idle_away disabled -> should NOT notify
  Object.assign(settingOverrides, { notify_idle_away: false });
  listeners = {};
  await extension.onStart({
    system_info: { api_feature_level: 3, cid: 'MYOWNCID000000000000000000000000000000' },
  });
  listeners['system/away_state']({ id: 'idle' });
  await listeners['private_chat/private_chat_message']({
    text: 'hi during idle',
    from: { nick: 'Alice', cid: 'OTHERCID0000000000000000000000000000000' },
  });
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 1, 'should not notify during idle away when disabled by setting');
  console.log('OK: idle-away notifications correctly suppressed when disabled');

  server.close();
  console.log('\nAll smoke tests passed.');
}

main().catch(e => {
  console.error('SMOKE TEST FAILED:', e);
  process.exitCode = 1;
});
