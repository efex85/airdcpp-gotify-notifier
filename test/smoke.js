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
let hubsList = [];

const socket = {
  logger: { warn: (...a) => console.log('[warn]', ...a), error: (...a) => console.log('[error]', ...a), info: () => {}, verbose: () => {} },
  get: async (path) => {
    if (path === 'system/away') return { id: 'manual' };
    if (path === 'hubs') return hubsList;
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

  // 5) Hub mention: our nick is mentioned by someone else, in a hub we're in
  //    -> should notify (mentions default to firing regardless of away state)
  Object.assign(settingOverrides, {
    notify_idle_away: true,
    notify_on_mentions: true,
    mentions_only_when_away: false,
  });
  hubsList = [
    { id: 42, identity: { name: 'Demo Hub' }, settings: { nick: 'Jani' } },
  ];
  listeners = {};
  await extension.onStart({
    system_info: { api_feature_level: 3, cid: 'MYOWNCID000000000000000000000000000000' },
  });
  listeners['system/away_state']({ id: 'off' }); // explicitly online/not away

  assert(listeners['hubs/hub_message'], 'hub_message listener should be registered');

  await listeners['hubs/hub_message']({
    text: 'hey Jani, check this out',
    from: { nick: 'Bob', cid: 'OTHERCID0000000000000000000000000000000' },
  }, 42);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 2, 'expected a mention notification even while online');
  assert.strictEqual(sentNotifications[1].body.title, 'Mentioned by Bob in Demo Hub');
  assert.strictEqual(sentNotifications[1].body.message, 'hey Jani, check this out');
  console.log('OK: notified for a hub mention regardless of away state (default behavior)');

  // 6) Nick appearing only as a substring of a longer word should NOT count
  //    as a mention (e.g. "Janissary" shouldn't trigger on nick "Jani")
  await listeners['hubs/hub_message']({
    text: 'the Janissary armor dropped',
    from: { nick: 'Bob', cid: 'OTHERCID0000000000000000000000000000000' },
  }, 42);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 2, 'a nick that is only a substring of a longer word must not match');
  console.log('OK: substring-only matches (e.g. "Janissary" vs "Jani") are correctly ignored');

  // 7) Our own messages in the hub (even if they happen to contain our nick)
  //    must not trigger a self-notification
  await listeners['hubs/hub_message']({
    text: 'Jani here, just testing',
    from: { nick: 'Jani', cid: 'MYOWNCID000000000000000000000000000000' },
  }, 42);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 2, 'should not notify about our own hub messages');
  console.log('OK: ignored our own hub message even though it contains our nick');

  // 8) Disabling "notify_on_mentions" turns the whole feature off
  Object.assign(settingOverrides, { notify_on_mentions: false });
  listeners = {};
  await extension.onStart({
    system_info: { api_feature_level: 3, cid: 'MYOWNCID000000000000000000000000000000' },
  });
  await listeners['hubs/hub_message']({
    text: 'hey Jani are you there',
    from: { nick: 'Bob', cid: 'OTHERCID0000000000000000000000000000000' },
  }, 42);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 2, 'mentions should not notify once the feature is disabled');
  console.log('OK: "notify_on_mentions" setting fully disables mention notifications');

  // 9) "mentions_only_when_away" restricts mentions to away mode, same as PMs
  Object.assign(settingOverrides, { notify_on_mentions: true, mentions_only_when_away: true });
  listeners = {};
  await extension.onStart({
    system_info: { api_feature_level: 3, cid: 'MYOWNCID000000000000000000000000000000' },
  });
  listeners['system/away_state']({ id: 'off' });
  await listeners['hubs/hub_message']({
    text: 'Jani, you around?',
    from: { nick: 'Bob', cid: 'OTHERCID0000000000000000000000000000000' },
  }, 42);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 2, 'should not notify while online when mentions are restricted to away mode');

  listeners['system/away_state']({ id: 'manual' });
  await listeners['hubs/hub_message']({
    text: 'Jani, you around?',
    from: { nick: 'Bob', cid: 'OTHERCID0000000000000000000000000000000' },
  }, 42);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 3, 'should notify once away, when mentions are restricted to away mode');
  console.log('OK: "mentions_only_when_away" correctly gates mentions behind away state');

  // 10) Bot-flagged senders are ignored for mention notifications (ADC hubs
  //     expose a "bot" flag on the sender, e.g. for hub welcome/stats bots)
  Object.assign(settingOverrides, {
    mentions_only_when_away: false,
    ignore_bot_mentions: true,
    mention_grace_period_seconds: 0,
  });
  listeners = {};
  await extension.onStart({
    system_info: { api_feature_level: 3, cid: 'MYOWNCID000000000000000000000000000000' },
  });
  listeners['system/away_state']({ id: 'off' });

  await listeners['hubs/hub_message']({
    text: 'Welcome Jani to the hub!',
    from: { nick: 'HubBot', cid: 'BOTCID00000000000000000000000000000000', flags: ['bot'] },
  }, 42);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 3, 'mentions from bot-flagged users should be ignored');

  await listeners['hubs/hub_message']({
    text: 'Jani, still here?',
    from: { nick: 'Bob', cid: 'OTHERCID0000000000000000000000000000000' },
  }, 42);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 4, 'non-bot mentions should still notify normally');
  console.log('OK: mentions from bot-flagged users are ignored, non-bot mentions still work');

  // 11) Mentions are ignored for a grace period right after (re)joining a hub,
  //     to catch welcome-bot messages that aren't flagged as bots (e.g. NMDC).
  //     Real-world hubs can send the welcome message in the very same instant
  //     as the join (the "connected" state update and the welcome message
  //     can race each other), so the grace period must be anchored to
  //     hub_created (join start), not to the later connect_state:'connected'
  //     transition - this simulates that race directly: hub_created fires,
  //     then the welcome message arrives with NO delay at all, and only
  //     *after that* does hub_updated report connect_state:'connected'.
  Object.assign(settingOverrides, { mention_grace_period_seconds: 1 });
  listeners = {};
  await extension.onStart({
    system_info: { api_feature_level: 3, cid: 'MYOWNCID000000000000000000000000000000' },
  });

  listeners['hubs/hub_created']({
    id: 42,
    identity: { name: 'Demo Hub' },
    settings: { nick: 'Jani' },
    connect_state: { id: 'connecting' },
  });

  // No delay at all here - the welcome message races the connect_state
  // update in real hubs, so the test must cover the zero-delay case too.
  await listeners['hubs/hub_message']({
    text: 'Welcome back, Jani!',
    from: { nick: 'WelcomeBot', cid: 'NMDCBOTCID000000000000000000000000000' },
  }, 42);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 4, 'mentions in the very same instant as joining should be suppressed by the grace period');

  // The "connected" state update lands after the welcome message - must not
  // reset or otherwise disturb the grace period that's already running.
  listeners['hubs/hub_updated']({
    id: 42,
    connect_state: { id: 'connected' },
  });

  await new Promise(r => setTimeout(r, 1100));
  await listeners['hubs/hub_message']({
    text: 'Jani, are you there now?',
    from: { nick: 'Bob', cid: 'OTHERCID0000000000000000000000000000000' },
  }, 42);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 5, 'mentions after the grace period has elapsed should notify normally');
  console.log('OK: post-join grace period suppresses welcome-bot mentions sent the same instant as joining, then expires correctly');

  // 12) A reconnect on an existing hub tab (no hub_created, just hub_updated
  //     transitioning back into "connecting") restarts the grace period too.
  listeners['hubs/hub_updated']({ id: 42, connect_state: { id: 'disconnected' } });
  listeners['hubs/hub_updated']({ id: 42, connect_state: { id: 'connecting' } });

  await listeners['hubs/hub_message']({
    text: 'Welcome back, Jani!',
    from: { nick: 'WelcomeBot', cid: 'NMDCBOTCID000000000000000000000000000' },
  }, 42);
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sentNotifications.length, 5, 'mentions right after a reconnect should also be suppressed by the grace period');
  console.log('OK: reconnecting on an existing hub tab also restarts the grace period');

  server.close();
  console.log('\nAll smoke tests passed.');
}

main().catch(e => {
  console.error('SMOKE TEST FAILED:', e);
  process.exitCode = 1;
});
