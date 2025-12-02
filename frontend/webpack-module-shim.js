// Webpack shim for Node.js 'module' module in browser environment
// This is used by Verovio WASM module which tries to import 'module' in Node.js context
// In browser, we just export an empty object

module.exports = {};

