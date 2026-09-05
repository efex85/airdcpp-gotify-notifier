require("source-map-support").install();
const ManagedExtension = require('airdcpp-extension').ManagedExtension;

// Entry point that is executed by AirDC++ when the extension is installed
// and managed by the application itself.
//
// This file isn't executed when running the development server, so it
// shouldn't contain any extension-specific code (see src/main.js instead).
//
// See https://github.com/airdcpp-web/airdcpp-extension-js for usage information
ManagedExtension(require('./main.js'), {
  // Possible custom options for airdcpp-apisocket can be listed here
});
