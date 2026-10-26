# Contributing

Thank you for improving BrowserMCP Extended. Use English for issues, pull
requests, public documentation, and user-facing text.

## Before changing code

Read the README, architecture notes, and known limitations. Reproduce a bug
before fixing it. Keep changes focused and identify any companion-repository
updates. Never commit credentials, personal browser data, HAR exports, or local
machine configuration.

## Development workflow

1. Fork and clone this repository, then create a branch from `main`.
2. Make the change and update affected documentation.
3. Run the validation commands documented in the README.
4. For browser changes, reload the unpacked extension and test in a disposable
   profile or against the included local fixture.
5. Open a pull request describing the problem, behavior, validation, and any
   compatibility changes. Include a screenshot for visible UI changes.

Use the existing JavaScript style and standard Node.js test runner. Add tests
for behavior that can regress; avoid tests that only repeat implementation.

## Protocol compatibility

Keep request IDs and the `messageResponse` envelope compatible. Changes to tool
schemas, command names, permissions, or the default port must be coordinated
with the companion repository. Write operational logs to stderr in the server;
stdout is reserved for MCP messages.

## Licensing

By submitting a contribution, you agree that it may be distributed under this
repository's Apache License 2.0. Preserve upstream notices and identify modified
third-party code.
