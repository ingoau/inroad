import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { ClaudeProgress, DraftInput, Result } from '../shared/api'
import * as ai from './ai'
import { configureClaude } from './claude'
import { attachmentFile, pickAttachments } from './files'
import { checkSent, deleteDraft, saveDraft, testMail, type MailCreds } from './mail'
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
  // Running requests the renderer can stop, by jobId.
  const running = new Map<string, AbortController>()
  const stoppable = async <T>(jobId: string, fn: (abort: AbortController) => Promise<T>) => {
    const abort = new AbortController()
    running.set(jobId, abort)
    try {
      return await fn(abort)
    } finally {
      running.delete(jobId)
    }
  }
  ipcMain.handle('claude:test', async () => ai.test(await config()))
  ipcMain.handle('claude:research', async (e, req) => stoppable(req.jobId, async (abort) => ai.researchAndDraft(await config(), req, emitTo(e.sender), abort)))
  ipcMain.handle('claude:draft', async (_e, req) => ai.draft(await config(), req))
  ipcMain.handle('claude:chat', async (e, req) => stoppable(req.jobId, async (abort) => ai.chat(await config(), req, emitTo(e.sender), abort)))
  ipcMain.handle('claude:learnVoice', async (_e, req) => ai.learnVoice(await config(), req))
  ipcMain.handle('claude:lookupEvent', async (e, req) => stoppable(req.jobId, async (abort) => ai.lookupEvent(await config(), req, emitTo(e.sender), abort)))
  ipcMain.handle('claude:cancel', (_e, jobId: string) => running.get(jobId)?.abort())
  ipcMain.handle('claude:applyEventAnswers', async (_e, req) => ai.applyEventAnswers(await config(), req))
  ipcMain.handle('claude:writingRules', async (_e, req) => ai.writingRules(await config(), req))
  ipcMain.handle('claude:parseOrganisations', async (_e, text: string) => ai.parseOrganisations(await config(), text))
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
  ipcMain.handle('mail:checkSent', (_e, checks) => withMail((c) => checkSent(c, checks)))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
