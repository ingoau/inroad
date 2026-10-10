import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { AgentQuestionRequest, ClaudeProgress, DraftInput, Result } from '../shared/api'
import * as ai from './ai'
import { configureClaude } from './claude'
import { attachmentFile, pickAttachments } from './files'
import { deleteDraft, saveDraft, testMail, type MailCreds } from './mail'
import { discoverMcpServers } from './mcp'
import { authenticate as authenticateMcp, authStatus as mcpAuthStatus, logout as logoutMcp } from './mcp-auth'
import { disposeOpencode, setQuestionHandler } from './opencode'
import { getAiConfig, getPublicSettings, getSecrets, updateSettings } from './settings'
import { loadState, saveState } from './store'

// Runs a mail operation with the saved (keychain-decrypted) credentials.
async function withMail<T>(fn: (creds: MailCreds) => Promise<Result<T>>): Promise<Result<T>> {
  const { mail, mailPassword } = await getSecrets()
  if (!mail || !mailPassword) return { ok: false, error: 'Connect your mailbox in Settings first' }
  return fn({ mail, password: mailPassword })
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: 'Inroad',
    // Native-feeling macOS window: content runs under the traffic lights.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#0f1011',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Links (e.g. in the research brief) open in the user's browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  configureClaude({
    workspace: join(app.getPath('userData'), 'agent-workspace'),
    clientApp: `inroad/${app.getVersion()}`,
    // MCP sign-in opens the browser itself; the module stays Electron-free.
    openExternal: (url) => shell.openExternal(url),
    // Packaged: a binary inside app.asar can't be spawned, so point at the unpacked copy (see asarUnpack).
    executable: app.isPackaged
      ? join(
          process.resourcesPath,
          'app.asar.unpacked/node_modules/@anthropic-ai',
          `claude-agent-sdk-${process.platform}-${process.arch}`,
          process.platform === 'win32' ? 'claude.exe' : 'claude',
        )
      : undefined,
  })
  electronApp.setAppUserModelId('au.ingo.inroad')
  // Dev: F12 toggles devtools; prod: disables reload shortcuts.
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))

  ipcMain.handle('store:load', () => loadState())
  ipcMain.handle('store:save', (_e, data: unknown) => saveState(data))
  ipcMain.handle('settings:get', () => getPublicSettings())
  ipcMain.handle('settings:set', (_e, patch) => updateSettings(patch))
  // The agent backend (Claude Agent SDK or the opencode CLI) runs here, so keys
  // and sign-ins stay out of the renderer. Progress streams back to the window.
  const config = () => getAiConfig()
  const emitTo = (sender: Electron.WebContents) => (p: ClaudeProgress) => !sender.isDestroyed() && sender.send('claude:progress', p)
  ipcMain.handle('claude:test', async () => ai.test(await config()))
  ipcMain.handle('claude:research', async (e, req) => ai.researchAndDraft(await config(), req, emitTo(e.sender)))
  ipcMain.handle('claude:draft', async (_e, req) => ai.draft(await config(), req))
  ipcMain.handle('claude:chat', async (e, req) => ai.chat(await config(), req, emitTo(e.sender)))
  ipcMain.handle('claude:learnVoice', async (_e, req) => ai.learnVoice(await config(), req))
  ipcMain.handle('claude:lookupEvent', async (e, req) => ai.lookupEvent(await config(), req, emitTo(e.sender)))
  ipcMain.handle('claude:applyEventAnswers', async (_e, req) => ai.applyEventAnswers(await config(), req))
  ipcMain.handle('claude:writingRules', async (_e, req) => ai.writingRules(await config(), req))
  ipcMain.handle('claude:parseOrganisations', async (_e, text: string) => ai.parseOrganisations(await config(), text))
  ipcMain.handle('claude:suggestLeads', async (e, req) => ai.suggestLeads(await config(), req, emitTo(e.sender)))

  // Mid-run questions from the opencode agent: broadcast each to every window,
  // then wait for the renderer to answer (or skip) before the run continues.
  const pendingQuestions = new Map<string, { request: AgentQuestionRequest; resolve: (answers: string[][]) => void }>()
  setQuestionHandler((request) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.webContents.isDestroyed()) win.webContents.send('agent:question', request)
    return new Promise<string[][]>((resolve) => pendingQuestions.set(request.requestId, { request, resolve }))
  })
  ipcMain.handle('agent:pendingQuestions', () => [...pendingQuestions.values()].map((p) => p.request))
  ipcMain.handle('agent:answerQuestion', (_e, requestId: string, answers: string[][]): Result<null> => {
    const pending = pendingQuestions.get(requestId)
    if (!pending) return { ok: false, error: 'That question is no longer waiting.' }
    pendingQuestions.delete(requestId)
    pending.resolve(Array.isArray(answers) ? answers : [])
    return { ok: true, value: null }
  })

  ipcMain.handle('mcp:discover', () => discoverMcpServers())
  ipcMain.handle('mcp:authStatus', () => mcpAuthStatus())
  ipcMain.handle('mcp:authenticate', (_e, id: string) => authenticateMcp(id))
  ipcMain.handle('mcp:logout', (_e, id: string) => logoutMcp(id))
  ipcMain.handle('mail:test', () => withMail((c) => testMail(c)))
  ipcMain.handle('mail:saveDraft', (_e, draft: DraftInput) =>
    withMail(async (c) => {
      let files
      try {
        files = await Promise.all((draft.attachments ?? []).map(attachmentFile))
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
      return saveDraft(c, draft, files)
    }),
  )
  ipcMain.handle('files:pickAttachments', (e) => pickAttachments(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('mail:deleteDraft', (_e, ref) => withMail((c) => deleteDraft(c, ref)))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Stop the background opencode server (when one was started).
app.on('will-quit', () => disposeOpencode())
