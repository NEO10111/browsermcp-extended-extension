# Known limitations

These boundaries describe the current implementation; avoid assuming full
Playwright or Chrome DevTools behavior from a tool name.

- **Snapshots:** a simplified DOM summary of up to 250 visible interactive
  elements, not the browser's complete accessibility tree. Shadow roots and
  separate frames are not comprehensively traversed. Generate fresh references
  after page changes; the reference registry is shared across clients.
- **Keyboard, hover, drag/drop:** use synthetic DOM events for several operations.
  They may not trigger native browser defaults or controls requiring trusted input.
- **Element screenshot:** returns an element bounding box and a viewport screenshot;
  it is not a cropped element-only image. Full-page capture requests CDP
  `captureBeyondViewport`; rendering of lazy content depends on the page.
- **Console:** only logs observed during `execute_script` evaluations are buffered
  (up to 100 shared entries). This is not continuous page-wide console monitoring.
- **JavaScript world:** the `world` hint is accepted for compatibility but is not
  currently enforced; CDP evaluation uses its default context. Evaluation timeout
  does not guarantee cancellation of an already running expression.
- **Cookies:** reading uses Chrome's cookies API. Writing/deletion currently use
  `document.cookie` on the active page. HttpOnly cookies cannot be set this way;
  `httpOnly` and deletion `url` arguments do not provide full browser-cookie API
  semantics. Domain/path restrictions still apply.
- **Clipboard:** depends on browser focus and permissions; the fallback may be
  unsupported by some pages or browser policies.
- **Frames:** explicit frame evaluation targets a known iframe context; this does
  not make all DOM tools automatically operate across frames.
- **Network:** root-target capture, bounded memory, partial bodies, and aggregated
  HAR timing. See [NETWORK.md](NETWORK.md).
- **Tab targeting:** most non-network tools act on the active tab. Multiple clients
  share the profile and can affect each other's active tab, references and captures.
- **Restricted pages:** internal browser pages and protected origins may reject
  scripting or debugger access.
- **Transport:** loopback-only but unauthenticated, with no WebSocket Origin
  allowlist. This is for trusted local use, not a multi-tenant service.
