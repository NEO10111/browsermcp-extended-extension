# Architecture and protocol

## Components

The MCP server speaks newline-delimited MCP messages on stdio, registers tool
schemas, validates tool arguments, and forwards correlated browser commands.
The Chrome MV3 worker connects to the local WebSocket while enabled. It routes
commands to Chrome APIs, injected DOM functions, or CDP. The popup controls
activation and preferences through runtime messages.

## Local messages

Server to extension:

```json
{"id":"unique-request-id","type":"listTabs","payload":{}}
```

Extension success:

```json
{"type":"messageResponse","payload":{"requestId":"unique-request-id","result":[]}}
```

Extension error:

```json
{"type":"messageResponse","payload":{"requestId":"unique-request-id","error":"Error message"}}
```

The compatibility `getActiveTabResult` response is also accepted. Standard
requests default to a 30-second transport timeout unless the tool specifies an
adjustment. Requests are correlated independently; a socket close rejects pending
work. The bridge binds only to `127.0.0.1`.

## Shared bridge

Each MCP client gets a stdio process. The first process binds the browser port;
other compatible processes connect as peers with `/?role=mcp-peer`, verify the
relay identity, and forward commands through the owner. Peers do not replace the
extension connection. When the owner exits, peers attempt to bind or reconnect.
Unrelated port occupants cause startup to fail rather than being terminated.
This protocol shares browser state; it does not isolate clients.

## Shared CDP attachment

`debugger-session.js` serializes acquire/release operations per tab and counts
leases. A network capture holds one lease for its lifetime. Temporary operations
such as evaluation, frame/file access, dialogs and screenshots take and release
another lease. They do not force-detach a running capture. External detach resets
attachment state and updates the capture status.

## Network command mapping

All network tools forward `type: networkCapture` with an `action` of `start`,
`stop`, `list`, `detail`, `clear`, or `exportHar`, plus validated parameters.
The extension owns per-tab records; the server owns optional HAR file writes.
Network state-changing commands are serialized per tab.

## Activation

`mcpEnabled` is persisted in Chrome local storage. OFF blocks new commands,
stops captures and disconnects the WebSocket; already launched work may finish.
The port and JavaScript timeout are stored as `wsPort` and `wsTimeout`. Enabled
workers retry connection using timers and Chrome alarms. No historical compiled
content script is required by the standalone handlers.
