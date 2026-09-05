'use strict';

// Entry point for extension-specific code.
//
// This extension sends a Gotify push notification whenever you receive a
// new private message while away mode (idle or manual) is enabled.
//
// Docs used while building this:
// - Extension entry structure: https://github.com/airdcpp-web/airdcpp-extension-js
// - Settings manager:          https://github.com/airdcpp-web/airdcpp-extension-settings-js
// - Socket reference:          https://github.com/airdcpp-web/airdcpp-apisocket-js/blob/master/GUIDE.md
// - Web API reference:         http://apidocs.airdcpp.net (Private chat / System groups)
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
    help: "Disable this if you don't want private message contents leaving your machine towards the Gotify server (only the sender's name will be sent instead)",
    type: 'boolean',
    default_value: true,
  }
];

const CONFIG_VERSION = 1;

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
  };
};
