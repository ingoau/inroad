import { contextBridge, ipcRenderer } from 'electron'
import type { AgentQuestionRequest, ClaudeProgress, InroadApi } from '../shared/api'

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
    suggestLeads: (req) => ipcRenderer.invoke('claude:suggestLeads', req),
    onProgress: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, p: ClaudeProgress) => cb(p)
      ipcRenderer.on('claude:progress', listener)
      return () => ipcRenderer.removeListener('claude:progress', listener)
    },
  },
  files: {
    pickAttachments: () => ipcRenderer.invoke('files:pickAttachments'),
  },
  agent: {
    onQuestion: (cb) => {
      const listener = (_e: Electron.IpcRendererEvent, req: AgentQuestionRequest) => cb(req)
      ipcRenderer.on('agent:question', listener)
      return () => ipcRenderer.removeListener('agent:question', listener)
    },
    pendingQuestions: () => ipcRenderer.invoke('agent:pendingQuestions'),
    answer: (requestId, answers) => ipcRenderer.invoke('agent:answerQuestion', requestId, answers),
  },
  mcp: {
    discover: () => ipcRenderer.invoke('mcp:discover'),
    authStatus: () => ipcRenderer.invoke('mcp:authStatus'),
    authenticate: (serverId) => ipcRenderer.invoke('mcp:authenticate', serverId),
    logout: (serverId) => ipcRenderer.invoke('mcp:logout', serverId),
  },
  mail: {
    test: () => ipcRenderer.invoke('mail:test'),
    saveDraft: (draft) => ipcRenderer.invoke('mail:saveDraft', draft),
    deleteDraft: (ref) => ipcRenderer.invoke('mail:deleteDraft', ref),
  },
}

contextBridge.exposeInMainWorld('api', api)
