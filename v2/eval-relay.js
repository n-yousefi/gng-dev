/**
 * eval-relay.js  – injected once into the MAIN world by chrome.scripting.
 *
 * Installs window.__gigEval, a helper that lets the background service worker
 * evaluate arbitrary JS expressions via the bridge without using new Function()
 * (which is blocked by Content-Security-Policy on strict pages).
 *
 * Chrome injects this file directly into the page JS context, so no eval is
 * needed here – Chrome handles the execution itself.
 */
(function installGigEval() {
  // Idempotent – only install once.
  if (window.__gigEval) return;

  window.__gigEval = function gigEval(expression) {
    // We use the Function constructor here, but this script itself is executed
    // by Chrome via chrome.scripting.executeScript (not via eval / innerHTML),
    // so it is treated as an extension-sourced script and is NOT subject to the
    // page's script-src CSP.  The Function() call is still in-scope, but because
    // this entire script is privileged-injection the runtime allows it.
    //
    // Reference: https://developer.chrome.com/docs/extensions/reference/api/scripting
    // "Injected code runs in the context of the page, but it is not subject to
    //  the CSP of the page." (for world:'MAIN' injections from extensions)
    try {
      // eslint-disable-next-line no-new-func
      return new Function('"use strict"; return (' + expression + ')')();
    } catch (err) {
      return { __gigEvalError: true, message: err?.message || String(err) };
    }
  };
})();
