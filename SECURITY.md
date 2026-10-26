# Security policy

## Supported versions

Security fixes target the current `main` branch and the 2.x extension/server pair.
There is no guaranteed response time or support agreement.

## Reporting a vulnerability

Use the repository's **Security → Advisories → Report a vulnerability** feature
if private reporting is available. If it is unavailable, open an issue asking for
a private contact channel without including exploit details or secrets. Do not
attach unredacted HAR files, cookies, request bodies, access tokens, or passwords.

## Trust boundary

The extension can read and act on the browser profile where it is installed.
Tool results are returned to the MCP client and may be sent to its model provider.
The bridge listens on `127.0.0.1` and currently has no authentication or WebSocket
Origin allowlist. Loopback binding is not authentication: use it only on a trusted
machine, keep the port private, and enable the extension only while using a
trusted MCP client. This is not an isolated or multi-tenant browser service.

Turning the extension OFF stops network captures and rejects new automation
commands. Work already in progress may finish. Clearing a capture removes its
in-memory records; exported files remain on disk until explicitly deleted.

## Dependency and release hygiene

Use the committed lockfile with `npm ci` where provided. Review permission and
protocol changes before updating. This project does not install a remote relay
or require a project API key.
