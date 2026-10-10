# Inroad — Agent Guide

## Project Overview
Electron + React + TypeScript app for researching and drafting personalized outreach emails. Saves drafts to IMAP (Gmail, Fastmail, iCloud, Outlook). Two AI backends: Claude Agent SDK (default, uses local Claude Code sign-in or Anthropic API key) and opencode CLI.

## Key Commands
```sh
npm install                    # install deps
npm run dev                    # hot-reload dev (electron-vite)
npm run typecheck              # tsc --noEmit on both tsconfigs
npm run build                  # typecheck + electron-vite build
npm run dist                   # build + electron-builder package
npm run test:claude -- test    # integration test (needs Claude sign-in or INROAD_TEST_KEY)
npm run test:mail              # needs local GreenMail; see scripts/test-mail.ts
```

## Architecture
- **Main process**: `src/main/index.ts` — registers IPC handlers, creates window, configures Claude SDK
- **Renderer**: `src/renderer/src/` — React 19 + Tailwind v4 + @tiptap editor
- **Preload**: `src/preload/index.ts` — exposes typed `window.api` via contextBridge
- **Shared types**: `src/shared/api.ts` — all IPC request/response types, `Result<T>` pattern
- **Entry HTML**: `src/renderer/index.html`

## TypeScript Config
Project references split Node (main/preload) and Web (renderer):
- `tsconfig.node.json` — main, preload, shared, electron-vite config
- `tsconfig.web.json` — renderer, preload `.d.ts`, shared
- Path alias `@/*` → `src/renderer/src/*`

## AI Providers
- **Claude**: `@anthropic-ai/claude-agent-sdk` (spawns native binary; unpacked via `asarUnpack`)
- **opencode**: runs local `opencode` CLI; config in Settings → AI agent (path, models, agent, fallback, sub-agent model)
- Switch via `aiProvider` setting; both use same IPC surface (`window.api.claude.*`)

## Secrets & Storage
- IMAP password, Anthropic API key, MCP headers/env stored in system keychain (via `keytar`)
- Falls back to unencrypted JSON in `app.getPath('userData')` if no keychain (some Linux)
- `secureStorage` flag in `PublicSettings` tells renderer which mode is active

## MCP Servers
- Discovered from user's existing Claude Code / opencode config (`mcp:discover`)
- OAuth servers share tokens with CLI credential store (sign-in/out affects both)
- Remote servers: headers/env encrypted in keychain; local stdio servers run via command

## IPC Pattern
All calls return `Result<T> = { ok: true; value: T } | { ok: false; error: string }`
Progress streams via `claude:progress` events (`ClaudeProgress` union)
opencode mid-run questions: `agent:question` event → renderer answers via `agent:answerQuestion`

## Build & Release
- `electron-builder.yml` defines targets: macOS (DMG/ZIP, ad-hoc signed, Liquid Glass icon via Xcode 26 `actool`), Windows (NSIS), Linux (AppImage + deb)
- GitHub Actions: push tag `v*` → builds all 3 platforms → publishes release
- Node 24 in CI; `asarUnpack` for Claude SDK native binary

## Code Style
- Prettier: `semi: false`, `singleQuote: true`, `printWidth: 160`
- No explicit lint script; typecheck is the main gate

## Testing Notes
- No unit test suite; integration tests only (`test:claude`, `test:mail`)
- `test:claude` requires signed-in Claude Code or `INROAD_TEST_KEY` env var
- `test:mail` requires GreenMail Docker container (see script)

## Gotchas
- Preload must output CommonJS (`index.cjs`) for sandboxed Electron
- `electron-vite dev --watch` handles HMR for both main and renderer
- Main process imports are ESM (`type: module` in package.json)
- Window is created after all IPC handlers registered
- Links in renderer always open in external browser (never in-app)