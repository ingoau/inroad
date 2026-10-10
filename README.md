<p align="center"><img src="build/icon.png" width="128" alt="Inroad icon"></p>

# Inroad

Research and draft personalised outreach emails in bulk, in your own voice. Built for things like finding sponsors and venues for a hackathon.

- **Folders and campaigns.** A folder holds shared context (usually an event); each campaign inside it (Sponsors, Venues…) says what you're asking for.
- **Research in the background.** Add organisations and Claude researches each one, writes a brief with sources and possible recipients, and drafts the email. Or let the agent suggest leads to contact, based on your event info.
- **Edit with Claude.** A rich editor, plus a chat sidebar where Claude suggests edits you accept or reject.
- **Saves to your Drafts folder** over IMAP (Gmail, Fastmail, iCloud, Outlook or any IMAP server). Inroad never sends anything.
- **Learns your voice.** Paste emails you've written to start, and every edit you make before saving teaches it more.
- Keyboard-first, with undo for everything, soft delete, version history and multiple chats per email.

## Install

Download the latest build from [Releases](https://github.com/ingoau/inroad/releases/latest).

The builds aren't signed or notarized, so your OS will warn you the first time.

### macOS (Apple Silicon)

1. Open `Inroad-x.y.z-mac-arm64.dmg` and drag **Inroad** to Applications.
2. Remove the quarantine flag so macOS will open it:

   ```sh
   xattr -d com.apple.quarantine /Applications/Inroad.app
   ```

   (If macOS says the app is damaged, run `xattr -cr /Applications/Inroad.app` instead.)

3. Open Inroad as usual.

### Windows

Run `Inroad-x.y.z-windows-setup.exe`. When SmartScreen says "Windows protected your PC", click **More info → Run anyway**.

### Linux

- **AppImage:** `chmod +x Inroad-x.y.z-linux-x86_64.AppImage`, then run it.
- **Debian/Ubuntu:** `sudo apt install ./Inroad-x.y.z-linux-amd64.deb`

## Setup

Inroad walks you through this the first time you open it.

- **AI agent:** setup asks which agent to use.
  - **Claude:** Inroad uses the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), so if you're logged in to Claude Code on your computer it uses those credentials. If you haven't signed in yet, install [Claude Code](https://claude.com/claude-code), run `claude` once in a terminal and log in. Or use an Anthropic API key instead (also in Settings → AI agent).
  - **opencode:** Inroad runs the [opencode](https://opencode.ai) CLI installed on your computer, using your own providers, models and agents. Set the opencode path, model, fallback model and agent in Settings → AI agent. You can also give research and chat their own models, and set a fallback model used once if a request fails, e.g. when a free provider runs out of usage. Leave the agent blank to use `inroad`, which can only search the web and read pages. While it works, the agent can pause and ask you a question mid-run, shown as a dialog you answer or skip.
- **Mailbox:** in Settings → Mailbox, enter your IMAP details and an app password (most providers require one). Passwords and keys are stored in your system keychain; if your computer has no keychain (some Linux setups), Inroad says so and stores them unencrypted in its settings file, readable only by your user account.
- **Event lookup:** "Find details" searches the web. With Claude it can also search connectors on your Claude account (Slack, email, docs). It only uses tools that read; anything that sends or changes data is blocked.
- **Desktop notifications (optional):** in Settings → AI agent, turn on a desktop notification when the agent finishes researching an organisation (or it fails), or has questions about your event. They only fire while the Inroad window is in the background, and are off by default.
- **MCP servers (optional):** in Settings → AI agent, connect [Model Context Protocol](https://modelcontextprotocol.io) servers to give the agent extra tools. **Add from your agent** lists the servers already set up for Claude Code or opencode on your computer so you can pick them in one click, or add one manually (a local command or a remote URL). Headers and environment variables are stored encrypted in your system keychain. Remote servers that use OAuth show a sign-in chip: **Sign in** opens your browser to authorise the server, and the token is kept in your existing Claude Code / opencode credential store, so Inroad and the terminal share the sign-in (and **Sign out** signs out both). Servers that take an API key instead use their configured headers.

Everything you write in Inroad is stored locally on your computer.

## Development

```sh
npm install
npm run dev        # run the app with hot reload
npm run typecheck
npm run dist       # package for the current platform into dist/
```

Integration checks:

```sh
npm run test:claude -- test   # needs a Claude Code sign-in (or INROAD_TEST_KEY)
npm run test:mail             # needs a local GreenMail server; see scripts/test-mail.ts
```

The app icon is an Icon Composer file at `design/Inroad.icon` (copied to `build/icon.icon` for packaging, which needs Xcode 26's `actool`).

### Releasing

Push a tag matching the version in `package.json`:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

GitHub Actions builds macOS, Windows and Linux and publishes the release.

## License

[GPL-3.0-or-later](LICENSE). You can use, change and share Inroad, but anything you distribute that's based on it must also be released under the GPL with its source code.
