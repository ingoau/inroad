import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Check, Loader2, LogOut, Pencil, Plug, Plus, Power, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  mcpServerKey,
  type DiscoveredMcpServer,
  type McpAuthState,
  type McpAuthStatus,
  type McpKeyValue,
  type McpServer,
  type PublicSettings,
} from '../../../../shared/api'
import { SettingsBlock, SettingsRow, SettingsSection } from './layout'

const TRANSPORTS: [McpServer['transport'], string][] = [
  ['stdio', 'Local (stdio)'],
  ['http', 'Remote (HTTP)'],
  ['sse', 'Remote (SSE)'],
]

const blankServer = (): McpServer => ({
  id: crypto.randomUUID(),
  name: '',
  transport: 'stdio',
  command: '',
  args: [],
  env: [],
  url: '',
  headers: [],
  enabled: true,
})

// One "KEY = value" row editor for env vars and headers.
function KeyValues({
  pairs,
  onChange,
  valuePlaceholder,
}: {
  pairs: McpKeyValue[]
  onChange: (pairs: McpKeyValue[]) => void
  valuePlaceholder: string
}) {
  const set = (i: number, patch: Partial<McpKeyValue>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <div className="space-y-2">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input className="w-36" value={p.key} onChange={(e) => set(i, { key: e.target.value })} placeholder="KEY" />
          <Input className="w-52" value={p.value} onChange={(e) => set(i, { value: e.target.value })} placeholder={valuePlaceholder} />
          <Button variant="ghost" size="icon-sm" title="Remove" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <X />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...pairs, { key: '', value: '' }])}>
        <Plus /> Add
      </Button>
    </div>
  )
}

// The add/edit form. A server's transport decides which fields matter.
function ServerDialog({ server, onCancel, onSave }: { server: McpServer; onCancel: () => void; onSave: (s: McpServer) => void }) {
  const [draft, setDraft] = useState(server)
  const remote = draft.transport !== 'stdio'
  const complete = !!draft.name.trim() && (remote ? !!draft.url.trim() : !!draft.command.trim())

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{server.name ? 'Edit MCP server' : 'Add MCP server'}</DialogTitle>
          <DialogDescription>Inroad connects to this server and lets the agent use its tools while researching and writing.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Name</span>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Context7" />
          </label>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Transport</span>
            <Select value={draft.transport} onValueChange={(v) => setDraft({ ...draft, transport: v as McpServer['transport'] })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSPORTS.map(([v, label]) => (
                  <SelectItem key={v} value={v}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {remote ? (
            <>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">URL</span>
                <Input value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://mcp.example.com/mcp" />
              </label>
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Headers</span>
                <KeyValues pairs={draft.headers} onChange={(headers) => setDraft({ ...draft, headers })} valuePlaceholder="Bearer …" />
              </div>
            </>
          ) : (
            <>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Command</span>
                <Input value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} placeholder="npx" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">Arguments</span>
                <Textarea
                  value={draft.args.join('\n')}
                  onChange={(e) => setDraft({ ...draft, args: e.target.value.split('\n') })}
                  placeholder={'-y\n@modelcontextprotocol/server-everything'}
                />
                <span className="block text-xs text-muted-foreground">One argument per line.</span>
              </label>
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Environment variables</span>
                <KeyValues pairs={draft.env} onChange={(env) => setDraft({ ...draft, env })} valuePlaceholder="value" />
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!complete}
            onClick={() =>
              onSave({
                ...draft,
                name: draft.name.trim(),
                command: draft.command.trim(),
                url: draft.url.trim(),
                args: draft.args.filter((a) => a.trim()),
              })
            }
          >
            {server.name ? 'Save' : 'Add server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Picker for MCP servers already configured in the user's Claude Code or
// opencode setup. Tick the ones to bring into Inroad, then add them at once.
function DiscoverDialog({ existing, onCancel, onAdd }: { existing: McpServer[]; onCancel: () => void; onAdd: (servers: McpServer[]) => void }) {
  const [items, setItems] = useState<DiscoveredMcpServer[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const already = (s: McpServer) => existing.some((e) => mcpServerKey(e) === mcpServerKey(s))

  useEffect(() => {
    let alive = true
    if (!window.api) {
      setItems([])
      return
    }
    window.api.mcp
      .discover()
      .then((found) => alive && setItems(found))
      .catch(() => alive && setItems([]))
    return () => {
      alive = false
    }
  }, [])

  const toggle = (s: McpServer) => {
    const key = mcpServerKey(s)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const chosen = (items ?? []).filter((d) => selected.has(mcpServerKey(d.server)))

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add from your agent</DialogTitle>
          <DialogDescription>MCP servers already set up for Claude Code or opencode on this computer. Pick the ones Inroad should use too.</DialogDescription>
        </DialogHeader>

        {items === null ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="animate-spin" /> Looking for servers…
          </p>
        ) : items.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">No MCP servers found. Add one manually instead.</p>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {items.map(({ server, source, scope, authenticated }) => {
              const added = already(server)
              const key = mcpServerKey(server)
              return (
                <button
                  key={key}
                  type="button"
                  disabled={added}
                  onClick={() => toggle(server)}
                  className="flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-60 disabled:hover:bg-transparent"
                >
                  <span className={'flex size-4 shrink-0 items-center justify-center rounded-sm border ' + (selected.has(key) || added ? 'bg-primary text-primary-foreground' : '')}>
                    {(selected.has(key) || added) && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{server.name}</span>
                      {authenticated && <span className="shrink-0 text-xs font-medium text-success">Signed in</span>}
                    </span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {server.transport === 'stdio' ? [server.command, ...server.args].filter(Boolean).join(' ') : server.url}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted-foreground">
                    {added ? 'Added' : source}
                    <span className="block max-w-40 truncate">{scope}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={chosen.length === 0} onClick={() => onAdd(chosen.map((d) => d.server))}>
            Add {chosen.length > 0 ? chosen.length : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// How each sign-in state reads in the UI.
const AUTH_LABELS: Record<McpAuthState, string> = {
  connected: 'Signed in',
  'needs-auth': 'Sign-in needed',
  failed: 'Sign-in failed',
  unknown: 'Not signed in',
}

// Settings → AI agent: the MCP servers the agent connects to. Add, edit,
// enable/disable or remove them; the backends pick up the enabled ones per run.
export function McpServersSection({ settings, onSaved }: { settings: PublicSettings | null; onSaved: (s: PublicSettings) => void }) {
  const servers = settings?.mcpServers ?? []
  const desktop = !!window.api
  const [editing, setEditing] = useState<McpServer | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [busy, setBusy] = useState(false)
  // OAuth sign-in state per server id, and which row is mid-flow.
  const [auth, setAuth] = useState<Map<string, McpAuthStatus>>(new Map())
  const [authBusy, setAuthBusy] = useState<string | null>(null)
  const [authError, setAuthError] = useState<{ id: string; message: string } | null>(null)

  const remoteKey = servers.filter((s) => s.transport !== 'stdio').map((s) => s.id).join(',')

  const refreshAuth = useCallback(async () => {
    if (!window.api) return
    try {
      setAuth(new Map((await window.api.mcp.authStatus()).map((s) => [s.id, s])))
    } catch {
      // Provider unavailable: keep the last known state.
    }
  }, [])

  useEffect(() => {
    void refreshAuth()
  }, [refreshAuth, remoteKey, settings?.aiProvider])

  const commit = async (next: McpServer[]) => {
    if (!window.api) return
    setBusy(true)
    try {
      onSaved(await window.api.settings.set({ mcpServers: next }))
    } finally {
      setBusy(false)
    }
  }

  const upsert = (server: McpServer) => {
    const exists = servers.some((s) => s.id === server.id)
    void commit(exists ? servers.map((s) => (s.id === server.id ? server : s)) : [...servers, server])
    setEditing(null)
  }

  const addMany = (picked: McpServer[]) => {
    const keys = new Set(servers.map(mcpServerKey))
    void commit([...servers, ...picked.filter((s) => !keys.has(mcpServerKey(s)))])
    setDiscovering(false)
  }

  const runAuth = async (server: McpServer, action: 'authenticate' | 'logout') => {
    if (!window.api) return
    setAuthBusy(server.id)
    setAuthError(null)
    try {
      const res = action === 'authenticate' ? await window.api.mcp.authenticate(server.id) : await window.api.mcp.logout(server.id)
      if (!res.ok) setAuthError({ id: server.id, message: res.error })
      await refreshAuth()
    } finally {
      setAuthBusy(null)
    }
  }

  return (
    <>
      <SettingsSection
        title="MCP servers"
        description="Connect Model Context Protocol servers to give the agent extra tools. Enabled servers load for research, chat and event lookups."
      >
        {servers.length === 0 ? (
          <SettingsBlock>
            <p className="text-sm text-muted-foreground">No servers connected.</p>
          </SettingsBlock>
        ) : (
          servers.map((s) => {
            const remote = s.transport !== 'stdio'
            // A remote server with static headers uses an API key, not OAuth.
            const oauth = remote && s.headers.length === 0
            const status = auth.get(s.id)
            const connected = status?.state === 'connected'
            const signingIn = authBusy === s.id
            return (
              <SettingsRow
                key={s.id}
                title={<span className={'font-medium ' + (s.enabled ? '' : 'text-muted-foreground')}>{s.name || 'Untitled server'}</span>}
                description={
                  <span className="font-mono text-xs text-muted-foreground">
                    {remote ? s.url : [s.command, ...s.args].filter(Boolean).join(' ')}
                    {signingIn && <span className="mt-1 block font-sans">Finish signing in in your browser…</span>}
                    {authError?.id === s.id && <span className="mt-1 block font-sans text-destructive">{authError.message}</span>}
                  </span>
                }
              >
                <Badge variant="outline">{remote ? s.transport : 'stdio'}</Badge>
                {oauth && (
                  <>
                    <Badge variant={connected ? 'secondary' : 'outline'} className={connected ? 'text-success' : 'text-muted-foreground'}>
                      {connected && <Check />}
                      {AUTH_LABELS[status?.state ?? 'unknown']}
                    </Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!desktop || busy || signingIn}
                      title="Opens your browser to sign in. The token is shared with the opencode/Claude Code CLIs."
                      onClick={() => runAuth(s, 'authenticate')}
                    >
                      {signingIn ? <Loader2 className="animate-spin" /> : null}
                      {connected ? 'Re-authenticate' : 'Sign in'}
                    </Button>
                    {connected && (
                      <Button variant="ghost" size="sm" className="text-destructive" disabled={!desktop || busy || signingIn} onClick={() => runAuth(s, 'logout')}>
                        <LogOut /> Sign out
                      </Button>
                    )}
                  </>
                )}
                {remote && !oauth && (
                  <Badge variant="outline" className="text-muted-foreground">
                    API key
                  </Badge>
                )}
                <Button
                  variant={s.enabled ? 'secondary' : 'ghost'}
                  size="sm"
                  disabled={!desktop || busy}
                  title={s.enabled ? 'Connected — click to turn off' : 'Off — click to connect'}
                  onClick={() => commit(servers.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Power className={s.enabled ? 'text-success' : 'text-muted-foreground'} />}
                  {s.enabled ? 'On' : 'Off'}
                </Button>
                <Button variant="ghost" size="icon-sm" title="Edit" disabled={!desktop} onClick={() => setEditing(s)}>
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title="Remove"
                  disabled={!desktop || busy}
                  onClick={() => commit(servers.filter((x) => x.id !== s.id))}
                >
                  <X />
                </Button>
              </SettingsRow>
            )
          })
        )}
        <SettingsBlock>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" disabled={!desktop || busy} onClick={() => setDiscovering(true)}>
              <Sparkles /> Add from your agent
            </Button>
            <Button variant="ghost" disabled={!desktop || busy} onClick={() => setEditing(blankServer())}>
              <Plug /> Add manually
            </Button>
          </div>
        </SettingsBlock>
      </SettingsSection>
      {discovering && <DiscoverDialog existing={servers} onCancel={() => setDiscovering(false)} onAdd={addMany} />}
      {editing && <ServerDialog key={editing.id} server={editing} onCancel={() => setEditing(null)} onSave={upsert} />}
    </>
  )
}
