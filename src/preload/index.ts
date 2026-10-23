import { contextBridge, ipcRenderer } from 'electron'
import type { ClaudeProgress, InroadApi } from '../shared/api'

const api: InroadApi = {
  platform: process.platform,
  store: {
    load: () => ipcRenderer.invoke('store:load'),
    save: (data) => ipcRenderer.invoke('store:save', data),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  claude: {
    test: () => ipcRenderer.invoke('claude:test'),
    research: (req) => ipcRenderer.invoke('claude:research', req),
    draft: (req) => ipcRenderer.invoke('claude:draft', req),
    chat: (req) => ipcRenderer.invoke('claude:chat', req),
    learnVoice: (req) => ipcRenderer.invoke('claude:learnVoice', req),
    lookupEvent: (req) => ipcRenderer.invoke('claude:lookupEvent', req),
    applyEventAnswers: (req) => ipcRenderer.invoke('claude:applyEventAnswers', req),
    writingRules: (req) => ipcRenderer.invoke('claude:writingRules', req),
    parseOrganisations: (text) => ipcRenderer.invoke('claude:parseOrganisations', text),
    cancel: (jobId) => ipcRenderer.invoke('claude:cancel', jobId),
    onProgress: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, p: ClaudeProgress) => cb(p)
      ipcRenderer.on('claude:progress', listener)
      return () => ipcRenderer.removeListener('claude:progress', listener)
    },
  },
  files: {
    pickAttachments: () => ipcRenderer.invoke('files:pickAttachments'),
  },
  mail: {
    test: () => ipcRenderer.invoke('mail:test'),
    saveDraft: (draft) => ipcRenderer.invoke('mail:saveDraft', draft),
    deleteDraft: (ref) => ipcRenderer.invoke('mail:deleteDraft', ref),
    checkSent: (checks) => ipcRenderer.invoke('mail:checkSent', checks),
  },
}

contextBridge.exposeInMainWorld('api', api)
