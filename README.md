Quick install: In the client, install from url: https://raw.githubusercontent.com/efex85/airdcpp-gotify-notifier/main/release/1.0.0/airdcpp-away-gotify-notifier-1.0.0.tgz


# airdcpp-away-gotify-notifier

An AirDC++ Web Client extension that sends a [Gotify](https://gotify.net/) push
notification whenever you receive a new private message while away mode
(idle or manual) is enabled.

## How it works

- Subscribes to the `system` API's `away_state` event to track whether away
  mode is currently off / idle / manual.
- Subscribes to the `private_chat` API's `private_chat_message` event across
  **all** private chat sessions (including brand-new ones from users you've
  never talked to before).
- When a message arrives from someone else while you're away, it POSTs a
  push message to your Gotify server using the app token you configure.
- Ignores messages that are just echoes of your own outgoing messages.

## 1. Create a Gotify application

In your Gotify web UI, go to **Apps** → **Create Application**, give it a
name (e.g. "AirDC++"), and copy the generated **token** — you'll need it
below together with your Gotify server's URL (e.g. `https://gotify.example.com`).

## 2. Build the extension

You need Node.js (14+) and npm on the machine you build this on (this does
**not** need to be the same machine that runs AirDC++).

```bash
npm install
npm run build
```

This produces `dist/main.js`, which is the only file that actually gets run
by AirDC++ (an all-in-one bundle — AirDC++ does not install npm dependencies
for extensions itself, so everything needs to be bundled up front).

A prebuilt `dist/main.js` is already included in this package, so you can
skip this step if you don't plan on changing the code.

## 3. Install it into AirDC++ Web Client

Copy this whole folder (containing `package.json` and `dist/main.js`) into
AirDC++'s extensions directory, under its own subfolder, e.g.:

- Windows: `%APPDATA%\AirDC++\Settings\extensions\airdcpp-away-gotify-notifier\`
- Linux: `~/.airdc++/extensions/airdcpp-away-gotify-notifier/`

Restart AirDC++ (new extensions on disk are only picked up on startup) or,
if your webclient build supports it, use **Settings → Extensions → Install
from file** and point it at a `.tar.gz`/`.tgz` of this folder instead
(`npm pack` will create one for you).

## 4. Configure it

Once loaded, go to **Settings → Extensions → airdcpp-away-gotify-notifier**
and fill in:

- **Gotify server URL** — e.g. `https://gotify.example.com` (no trailing slash)
- **Gotify application token** — the token from step 1
- **Notification priority** — 0-10, higher triggers louder alerts on your phone
- **Also notify during idle away mode** — on by default; turn off if you
  only want notifications while *manually* marked away, not when AirDC++
  auto-marks you away due to inactivity
- **Include the message text in the notification** — on by default; turn
  off if you don't want PM contents leaving your machine towards the
  Gotify server (only the sender's name will be sent instead)

You can right-click the extension in the extensions list and choose **Send
test Gotify notification** to verify your settings without needing to wait
for an actual PM.

## Development

- `src/main.js` — the actual extension logic (entry point used by the dev
  server / when editing).
- `src/index.js` — production entry point that wraps `main.js` with
  `ManagedExtension` (only used in the built `dist/main.js`).
- `test/smoke.js` — a standalone Node script that exercises the core logic
  (away-state tracking, self-message filtering, idle-away toggle) against a
  mocked socket and a real local HTTP server standing in for Gotify. Run it
  with `node test/smoke.js` after `npm install`.

## References

- [AirDC++ Web API reference](http://apidocs.airdcpp.net)
- [airdcpp-extension-js](https://github.com/airdcpp-web/airdcpp-extension-js)
- [airdcpp-apisocket-js](https://github.com/airdcpp-web/airdcpp-apisocket-js)
- [airdcpp-create-extension starter](https://github.com/airdcpp-web/airdcpp-create-extension)
- [Gotify push message API](https://gotify.net/docs/pushmsg)
