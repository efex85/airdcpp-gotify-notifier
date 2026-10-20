'use strict';

// Entry point for extension-specific code.
//
// This extension sends a Gotify push notification whenever you receive a
// new private message while away mode (idle or manual) is enabled, and
// (optionally, independent of away mode) whenever your nick is mentioned in
// a hub's public chat.
//
// Docs used while building this:
// - Extension entry structure: https://github.com/airdcpp-web/airdcpp-extension-js
// - Settings manager:          https://github.com/airdcpp-web/airdcpp-extension-settings-js
// - Socket reference:          https://github.com/airdcpp-web/airdcpp-apisocket-js/blob/master/GUIDE.md
// - Web API reference:         http://apidocs.airdcpp.net (Private chat / System / Hubs groups)
//     - GET /hubs returns every open hub session, including this client's
//       current nick in that hub (settings.nick) and the hub's name
//       (identity.name). There's no per-message "this mentions you" flag in
//       the API (only an aggregate unread "mention" counter per hub), so
//       matching your nick against the message text is done locally here.
// - Gotify push message API:   https://gotify.net/docs/pushmsg

const https = require('https');
const http = require('http');
const { URL } = require('url');

const { addContextMenuItems } = require('airdcpp-apisocket');
const SettingsManager = require('airdcpp-extension-settings');

const SettingDefinitions = [
  {
    key: 'gotify_url',
    title: 'Gotify server URL',
    help: 'Base URL of your Gotify server, e.g. https://gotify.example.com (no trailing slash)',
    type: 'url',
    default_value: '',
  }, {
    key: 'gotify_token',
    title: 'Gotify application token',
    help: 'Token of the Gotify "application" that should send these notifications (created in the Gotify web UI)',
    type: 'password',
    default_value: '',
  }, {
    key: 'gotify_priority',
    title: 'Notification priority',
    help: 'Gotify message priority (0-10). Higher values are more likely to trigger a sound/alert on your device',
    type: 'number',
    min: 0,
    max: 10,
    default_value: 5,
  }, {
    key: 'notify_idle_away',
    title: 'Also notify during idle away mode',
    help: 'If disabled, notifications will only be sent while manual away mode is enabled (not automatic/idle away)',
    type: 'boolean',
    default_value: true,
  }, {
    key: 'include_message_text',
    title: 'Include the message text in the notification',
    help: "Disable this if you don't want message contents leaving your machine towards the Gotify server (only the sender's name/hub will be sent instead)",
    type: 'boolean',
    default_value: true,
  }, {
    key: 'notify_on_mentions',
    title: 'Notify when your nick is mentioned in hub chat',
    help: 'Sends a notification whenever someone mentions your current nick in a hub\'s public chat (not just private messages).',
    type: 'boolean',
    default_value: true,
  }, {
    key: 'mentions_only_when_away',
    title: 'Only notify about mentions while away',
    help: 'If enabled, nick-mention notifications follow the same away-mode rules as private messages above. If disabled (default), you get notified about mentions regardless of away status, since they\'re easy to miss in a busy hub even while active.',
    type: 'boolean',
    default_value: false,
  }
];

const CONFIG_VERSION = 1;

const isWordChar = (ch) => !!ch && /[A-Za-z0-9_]/.test(ch);

// Case-insensitive "was this nick mentioned" check: matches the nick
// anywhere in the text as long as it isn't part of a longer word (so "Jani"
// matches "hey Jani!" or "@Jani," but not "Janissary"). Mirrors the kind of
// nick-highlighting heuristic classic DC++ clients use locally, since the
// Web API doesn't expose a per-message "mentions you" flag.
const containsMention = (text, nick) => {
  if (!text || !nick) {
    return false;
  }

  const lowerText = text.toLowerCase();
  const lowerNick = nick.toLowerCase();

  let fromIndex = 0;
  while (fromIndex <= lowerText.length) {
    const idx = lowerText.indexOf(lowerNick, fromIndex);
    if (idx === -1) {
      return false;
    }

    const before = idx > 0 ? text[idx - 1] : '';
    const after = idx + nick.length < text.length ? text[idx + nick.length] : '';

    if (!isWordChar(before) && !isWordChar(after)) {
      return true;
    }

    fromIndex = idx + 1;
  }

  return false;
};

module.exports = function (socket, extension) {
  const settings = SettingsManager(socket, {
    extensionName: extension.name,
    configFile: extension.configPath + 'config.json',
    configVersion: CONFIG_VERSION,
    definitions: SettingDefinitions,
  });

  // Current away state as reported by the application ('off', 'idle' or 'manual')
  let awayState = 'off';

  // Our own CID, used to ignore messages that we sent ourselves
  let ownCid = null;

  let removeAwayListener = null;
  let removeMessageListener = null;
  let removeHubMessageListener = null;
  let removeHubCreatedListener = null;
  let removeHubUpdatedListener = null;
  let removeHubRemovedListener = null;

  // hubId -> { nick, name }. Needed because your nick (and obviously the hub
  // name) can differ per hub, and chat message events only give us the hub's
  // session ID, not this information directly.
  const hubInfoById = new Map();

  const updateHubInfo = (hub) => {
    if (!hub || hub.id === undefined) {
      return;
    }

    const existing = hubInfoById.get(hub.id) || {};
    hubInfoById.set(hub.id, {
      nick: (hub.settings && hub.settings.nick) || existing.nick,
      name: (hub.identity && hub.identity.name) || existing.name,
    });
  };

  const isAwayNotificationEnabled = () => {
    if (awayState === 'off') {
      return false;
    }

    if (awayState === 'idle') {
      return settings.getValue('notify_idle_away');
    }

    // manual away mode
    return true;
  };

  // Minimal dependency-free HTTP(S) POST helper (avoids shipping/bundling an
  // extra HTTP client just for this one request)
  const postJson = (baseUrl, requestPath, data, headers) => {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(requestPath, baseUrl);
      } catch (e) {
        reject(new Error(`Invalid Gotify server URL: ${e.message}`));
        return;
      }

      const payload = Buffer.from(JSON.stringify(data), 'utf8');
      const transport = target.protocol === 'http:' ? http : https;

      const req = transport.request(target, {
        method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        }, headers),
      }, (res) => {
        // Drain the response body so the socket can be released
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`Gotify server responded with HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  };

  const sendGotifyNotification = async (title, message) => {
    const url = settings.getValue('gotify_url');
    const token = settings.getValue('gotify_token');

    if (!url || !token) {
      socket.logger.warn('Gotify URL/token are not configured, skipping notification');
      return;
    }

    try {
      await postJson(url, '/message', {
        title,
        message,
        priority: settings.getValue('gotify_priority'),
      }, {
        'X-Gotify-Key': token,
      });
    } catch (e) {
      socket.logger.error(`Failed to send Gotify notification: ${e.message}`);
    }
  };

  // Fired for chat messages in all private chat sessions (existing and newly created ones),
  // see https://github.com/airdcpp-web/airdcpp-apidocs (Private chat > Event listeners)
  const onPrivateMessage = (message) => {
    if (!isAwayNotificationEnabled()) {
      return;
    }

    if (!message.from || (ownCid && message.from.cid === ownCid)) {
      // Ignore messages that we sent ourselves (echoes of outgoing messages)
      return;
    }

    const nick = message.from.nick || 'Unknown user';
    const includeText = settings.getValue('include_message_text');

    sendGotifyNotification(
      `PM from ${nick}`,
      includeText ? message.text : 'New private message received while away'
    );
  };

  const onAwayStateChanged = (data) => {
    awayState = data.id;
  };

  // Fired for chat messages in all hubs (public chat only - status
  // messages/joins/parts use a separate "hub_status" event we don't subscribe to)
  const onHubMessage = (message, hubId) => {
    if (!settings.getValue('notify_on_mentions')) {
      return;
    }

    if (settings.getValue('mentions_only_when_away') && !isAwayNotificationEnabled()) {
      return;
    }

    if (!message.from || (ownCid && message.from.cid === ownCid)) {
      // Ignore messages that we sent ourselves
      return;
    }

    const hubInfo = hubInfoById.get(hubId);
    if (!hubInfo || !hubInfo.nick) {
      // Don't know our own nick in this hub - can't safely match, so skip
      // rather than risk noisy false positives/negatives
      return;
    }

    if (!containsMention(message.text, hubInfo.nick)) {
      return;
    }

    const fromNick = message.from.nick || 'Unknown user';
    const hubName = hubInfo.name || 'a hub';
    const includeText = settings.getValue('include_message_text');

    sendGotifyNotification(
      `Mentioned by ${fromNick} in ${hubName}`,
      includeText ? message.text : 'Your nick was mentioned in hub chat'
    );
  };

  extension.onStart = async (sessionInfo) => {
    await settings.load();

    ownCid = sessionInfo && sessionInfo.system_info && sessionInfo.system_info.cid;

    try {
      const currentAway = await socket.get('system/away');
      awayState = currentAway.id;
    } catch (e) {
      socket.logger.error(`Failed to fetch the current away state: ${e.message}`);
    }

    removeAwayListener = await socket.addListener('system', 'away_state', onAwayStateChanged);

    // No entity ID supplied -> listen across all private chat sessions, including ones
    // that don't exist yet (i.e. the very first PM from someone new)
    removeMessageListener = await socket.addListener('private_chat', 'private_chat_message', onPrivateMessage);

    try {
      const hubs = await socket.get('hubs');
      hubs.forEach(updateHubInfo);
    } catch (e) {
      socket.logger.error(`Failed to fetch open hub sessions: ${e.message}`);
    }

    removeHubCreatedListener = await socket.addListener('hubs', 'hub_created', updateHubInfo);
    removeHubUpdatedListener = await socket.addListener('hubs', 'hub_updated', updateHubInfo);
    removeHubRemovedListener = await socket.addListener('hubs', 'hub_removed', (hub) => {
      if (hub && hub.id !== undefined) {
        hubInfoById.delete(hub.id);
      }
    });

    // No entity ID supplied -> listen across all hub sessions
    removeHubMessageListener = await socket.addListener('hubs', 'hub_message', onHubMessage);

    if (sessionInfo.system_info.api_feature_level >= 4) {
      addContextMenuItems(
        socket,
        [
          {
            id: 'send_test_gotify_notification',
            title: 'Send test Gotify notification',
            icon: {
              semantic: 'blue bell' // https://fomantic-ui.com/elements/icon.html
            },
            onClick: () => {
              sendGotifyNotification(
                'AirDC++ test notification',
                'This is a test message from the away-notifier extension.'
              );
            },
            access: 'settings_view',
            filter: selectedIds => selectedIds.indexOf(extension.name) !== -1
          }
        ],
        'extension',
        {
          id: extension.name,
          name: 'Away PM notifier'
        },
      );
    }
  };

  extension.onStop = () => {
    if (removeAwayListener) {
      removeAwayListener();
    }

    if (removeMessageListener) {
      removeMessageListener();
    }

    if (removeHubMessageListener) {
      removeHubMessageListener();
    }

    if (removeHubCreatedListener) {
      removeHubCreatedListener();
    }

    if (removeHubUpdatedListener) {
      removeHubUpdatedListener();
    }

    if (removeHubRemovedListener) {
      removeHubRemovedListener();
    }
  };
};
