# Network capture

## Lifecycle and targeting

All six `browser_network_*` tools accept `tabId`. The active tab is used only if
it is omitted. Keep the same explicit ID across calls. Start capture before
reloading or triggering the relevant interaction. Capture is not retroactive.
Calling start on a running capture preserves its buffer; starting a stopped
capture creates a fresh buffer. Stop ends collection and releases the capture's
debugger lease, while preserving recorded data. Clear removes records without
stopping an active capture. Extension reload or tab closure loses the in-memory
capture. Disabling the extension stops all active captures.

## Recorded information

- HTTP method, URL, resource type, request headers and available POST data.
- Response status, headers, MIME type, CDP response timing, cache/service-worker
  indicators, encoded data length, and available response body.
- Redirect hops as separate records with unique IDs.
- Load failures, blocked reasons, and CORS error information when CDP supplies it.
- WebSocket creation/handshake, recent sent/received frames, closure, and errors.

List returns summaries and supports URL-substring, exact method, status, and
case-insensitive resource-type filters. `offset` starts at zero and `limit` is
1–500 (100 by default). Detail accepts the exact `id` from list as `requestId`;
this public ID is distinct from the underlying CDP request ID on redirect chains.

## Bounded buffers

| Buffer | Limit |
| --- | --- |
| Retained requests per tab | 1000 by default; `maxEntries` accepts 1–5000 |
| POST text per request | 16384 JavaScript characters |
| Response text per request | 262144 JavaScript characters |
| Combined response/frame text budget | 8388608 JavaScript characters per capture |
| Retained WebSocket frames per request | 100, each capped at 16384 characters |
| CDP network buffer | 16 MiB total; 256 KiB per resource |

Old records are evicted; `dropped` reports their count. Text can be truncated;
inspect `truncated`/`postDataTruncated`. Oversized binary bodies are omitted so a
partial base64 value is not presented as a valid resource. `bodyError` explains
omitted, unavailable, or browser-evicted bodies. Setting `captureBodies: false`
skips response-body retrieval; request metadata and WebSocket frames are still
recorded. These are bounded diagnostic records, not a lossless packet capture.

## Scope

Capture uses the tab's root CDP session. It does not separately attach to worker
or out-of-process iframe targets, so their traffic may be missing. Interactions
that start only after a user gesture, such as video playback, are not necessarily
triggered by an initial page load. Capture the loading sequence and the relevant
interaction to diagnose them. A cached resource may still appear in the list.
Opening DevTools or browser actions can detach the debugger; inspect
`capturing` and `stoppedReason` and restart when needed.

## HAR export

The export contains HAR 1.2 request/response entries and available bodies.
Query parameters are extracted from the captured URL. Aggregate request duration
is recorded; detailed send/wait/receive phases are not reconstructed. Unknown
sizes and phases use supported sentinel fields or estimates; `_sizeEstimated`
marks estimated content sizes. `_truncated`, `_bodyError`, `_error`, `_id`, and
`_webSocketFrames` preserve extra capture information.

The server can return JSON or write a new file at `filePath`. The parent directory
must exist. Existing files are not overwritten. Stopping capture first produces
a stable export; a running capture may continue receiving new requests. Exported
files are not removed by clear or by switching the extension OFF.

A HAR can contain cookies, tokens, full URLs, request bodies and personal data.
Sanitize it before sharing it in an issue or committing it. The repository
ignores `*.har` files by default.
