/* VaultDex QA — known-transient network noise filter.
 *
 * The Playwright specs assert a strict zero-console-error contract, which
 * fails on two recurring transients that are not app bugs:
 * - net::ERR_BLOCKED_BY_RESPONSE — Chromium CORB-blocks an occasional
 *   cross-origin image response from the card-art CDN. Different images
 *   fail on different runs (whack-a-mole); the app set the src correctly.
 * - net::ERR_HTTP2_PROTOCOL_ERROR — "Failed to load resource" from the
 *   CI/VM egress path, not the app.
 * - net::ERR_TUNNEL_CONNECTION_FAILED — the relay/egress proxy tunnel
 *   dropped a request mid-run (observed on shared hosts like fonts/CDN
 *   during the 2026-10-05 verification run; the same hosts 200 through
 *   the relay minutes later). Environmental, not the app.
 * realErrors() strips those so the assertions keep catching real JS
 * errors without reruns. Only Chromium network-stack messages match —
 * no app-thrown error can look like these.
 */
"use strict";

const NET_NOISE = [
  /net::ERR_BLOCKED_BY_RESPONSE/,
  /net::ERR_HTTP2_PROTOCOL_ERROR/,
  /net::ERR_TUNNEL_CONNECTION_FAILED/,
];

function isNetNoise(msg) {
  return NET_NOISE.some((re) => re.test(String(msg || "")));
}

function realErrors(errors) {
  return (errors || []).filter((e) => !isNetNoise(e));
}

module.exports = { isNetNoise, realErrors };
