import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Check, CircleAlert, Loader2, Trash2, TriangleAlert } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { MailSettings, PublicSettings } from '../../../../shared/api'
import { emailHtml, emailStyleVars, type EmailStyle } from '../../markdown'
import { globalShortcuts, NAV_SHORTCUTS } from '../CommandPalette'
import { Keys } from '../hint'
import { SettingsBlock, SettingsRow, SettingsSection } from './layout'

type Status = { ok: boolean; message: string } | null

function StatusLine({ status }: { status: Status }) {
  if (!status) return null
  return (
    <p className={`flex items-start gap-2 text-sm ${status.ok ? 'text-success' : 'text-destructive'}`}>
      {status.ok ? <Check className="mt-0.5 size-4 shrink-0" /> : <CircleAlert className="mt-0.5 size-4 shrink-0" />}
      {status.message}
    </p>
  )
}

// Shown when the OS has no keychain, so the user knows secrets aren't encrypted.
function InsecureStorageNotice() {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
      <p className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        <span>
          This computer has no system keychain, so your password or key is saved unencrypted in Inroad’s settings file (readable only by your user account).
          Install a keychain service (e.g. gnome-keyring or kwallet) to encrypt it.
        </span>
      </p>
    </div>
  )
}

function Choice<T extends string>({ value, onChange, options, id }: { value: T; onChange: (v: T) => void; options: [T, string][]; id?: string }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger id={id} className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, label]) => (
          <SelectItem key={v} value={v}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------- Mailbox

// Common providers' IMAP servers. All of them want an app-specific password
// rather than your normal login password.
const PROVIDERS = {
  gmail: { label: 'Gmail', host: 'imap.gmail.com', port: 993, secure: true, help: 'Use an app password (Google Account → Security → App passwords).' },
  fastmail: {
    label: 'Fastmail',
    host: 'imap.fastmail.com',
    port: 993,
    secure: true,
    help: 'Use an app password (Settings → Privacy & Security → App passwords).',
  },
  icloud: { label: 'iCloud', host: 'imap.mail.me.com', port: 993, secure: true, help: 'Use an app-specific password from appleid.apple.com.' },
  outlook: { label: 'Outlook', host: 'outlook.office365.com', port: 993, secure: true, help: 'Your account may need IMAP enabled and an app password.' },
  other: { label: 'Other', host: '', port: 993, secure: true, help: 'Ask your provider for their IMAP server details.' },
} as const
type Provider = keyof typeof PROVIDERS
const detect = (host: string): Provider => (Object.entries(PROVIDERS).find(([, p]) => p.host && p.host === host)?.[0] as Provider) ?? 'other'

// Also used by onboarding. Passwords go straight to the keychain and are never read back.
export function MailboxForm({ settings, onSaved }: { settings: PublicSettings | null; onSaved: (s: PublicSettings) => void }) {
  const [provider, setProvider] = useState<Provider>(settings?.mail ? detect(settings.mail.host) : 'gmail')
  const [mail, setMail] = useState<MailSettings>(
    settings?.mail ?? { host: PROVIDERS.gmail.host, port: 993, secure: true, user: '', fromName: '', fromEmail: '' },
  )
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const pick = (p: Provider) => {
    setProvider(p)
    if (p !== 'other') setMail((m) => ({ ...m, host: PROVIDERS[p].host, port: PROVIDERS[p].port, secure: PROVIDERS[p].secure }))
  }
  const desktop = !!window.api
  const complete = !!(mail.host && mail.port && mail.user && mail.fromEmail && (password || settings?.hasMailPassword))

  const save = async () => {
    if (!window.api) return
    setBusy(true)
    setStatus(null)
    try {
      onSaved(await window.api.settings.set({ mail, ...(password ? { mailPassword: password } : {}) }))
      setPassword('')
      const res = await window.api.mail.test()
      setStatus(res.ok ? { ok: true, message: `Connected. Drafts go to “${res.value.draftsMailbox}”.` } : { ok: false, message: res.error })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {settings && !settings.secureStorage && <InsecureStorageNotice />}
      <SettingsSection title="You">
        <SettingsRow title="Name" description="Shown as the sender, and how the AI signs off emails." htmlFor="fromName">
          <Input
            id="fromName"
            className="w-64"
            value={mail.fromName}
            onChange={(e) => setMail({ ...mail, fromName: e.target.value })}
            placeholder="Jordan Ellis"
          />
        </SettingsRow>
        <SettingsRow title="Email address" htmlFor="fromEmail">
          <Input
            id="fromEmail"
            type="email"
            className="w-64"
            value={mail.fromEmail}
            // The login is usually the same as the address; keep them in step until the user changes it.
            onChange={(e) => setMail({ ...mail, fromEmail: e.target.value, user: mail.user === mail.fromEmail ? e.target.value : mail.user })}
            placeholder="you@example.com"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Server">
        <SettingsRow title="Provider" description={PROVIDERS[provider].help} htmlFor="provider">
          <Choice id="provider" value={provider} onChange={pick} options={(Object.keys(PROVIDERS) as Provider[]).map((p) => [p, PROVIDERS[p].label])} />
        </SettingsRow>
        {provider === 'other' && (
          <>
            <SettingsRow title="IMAP server" htmlFor="host">
              <Input
                id="host"
                className="w-64"
                value={mail.host}
                onChange={(e) => setMail({ ...mail, host: e.target.value.trim() })}
                placeholder="imap.example.com"
              />
            </SettingsRow>
            <SettingsRow title="Port and security" htmlFor="port">
              <Input
                id="port"
                inputMode="numeric"
                className="w-20"
                value={mail.port}
                onChange={(e) => setMail({ ...mail, port: Number(e.target.value) || 0 })}
              />
              <Choice
                value={mail.secure ? 'tls' : 'starttls'}
                onChange={(v) => setMail({ ...mail, secure: v === 'tls' })}
                options={[
                  ['tls', 'SSL/TLS'],
                  ['starttls', 'STARTTLS'],
                ]}
              />
            </SettingsRow>
          </>
        )}
        <SettingsRow title="Username" description="Usually your email address." htmlFor="user">
          <Input id="user" className="w-64" value={mail.user} onChange={(e) => setMail({ ...mail, user: e.target.value })} />
        </SettingsRow>
        <SettingsRow
          title="App password"
          description={settings?.secureStorage ? 'Stored in your system keychain.' : 'No system keychain found — stored locally, unencrypted.'}
          htmlFor="password"
        >
          <Input
            id="password"
            type="password"
            autoComplete="off"
            className="w-64"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={settings?.hasMailPassword ? 'Saved — type to replace' : ''}
          />
        </SettingsRow>
      </SettingsSection>

      <div className="flex items-center gap-3">
        <Button disabled={!desktop || busy || !complete} onClick={save}>
          {busy && <Loader2 className="animate-spin" />} Save & test connection
        </Button>
        <StatusLine status={status} />
      </div>
      {!desktop && <p className="text-sm text-muted-foreground">Mailbox settings are only available in the desktop app.</p>}
    </div>
  )
}

export function MailboxPage(props: { settings: PublicSettings | null; onSaved: (s: PublicSettings) => void }) {
  return (
    <>
      <Intro>Inroad saves each email to your mailbox’s Drafts folder over IMAP, so you send it from your normal mail app. It never sends anything.</Intro>
      {/* Remount when saved settings first arrive, so the form starts from them. */}
      <MailboxForm key={props.settings ? 'loaded' : 'loading'} {...props} />
    </>
  )
}

// ---------------------------------------------------------------- Email style

const SAMPLE = `Hi Sam,

I'm organising **Haven Canberra**, a free game jam for teens in November. More at [haven.hackclub.com](https://haven.hackclub.com/canberra).

Would you be keen to:
- judge on the Sunday
- give a short talk

Cheers,
Ingo`

export function EmailStylePage({ style, onChange }: { style: EmailStyle; onChange: (s: EmailStyle) => void }) {
  const set = (patch: Partial<EmailStyle>) => onChange({ ...style, ...patch })
  const preview = useMemo(() => emailHtml(SAMPLE, style), [style])
  return (
    <>
      <Intro>How emails look when they’re saved to Drafts. The editor shows the same spacing and font.</Intro>
      <SettingsSection title="Text">
        <SettingsRow title="Font" description="“Mail app default” leaves it to whoever reads it.">
          <Choice
            value={style.font}
            onChange={(font) => set({ font })}
            options={[
              ['default', 'Mail app default'],
              ['sans', 'Sans-serif'],
              ['serif', 'Serif'],
            ]}
          />
        </SettingsRow>
        <SettingsRow title="Size">
          <Choice
            value={style.size}
            onChange={(size) => set({ size })}
            options={[
              ['default', 'Mail app default'],
              ['small', 'Small (13px)'],
              ['medium', 'Medium (14px)'],
              ['large', 'Large (16px)'],
            ]}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Spacing">
        <SettingsRow title="Between paragraphs" description="The gap between paragraphs, lists and quotes.">
          <Choice
            value={style.spacing}
            onChange={(spacing) => set({ spacing })}
            options={[
              ['normal', 'One line'],
              ['compact', 'Half a line'],
              ['none', 'None'],
            ]}
          />
        </SettingsRow>
        <SettingsRow title="Line height">
          <Choice
            value={style.lineHeight}
            onChange={(lineHeight) => set({ lineHeight })}
            options={[
              ['normal', 'Mail app default'],
              ['relaxed', 'Relaxed'],
            ]}
          />
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title="Preview">
        <SettingsBlock>
          {/* Same HTML that goes to the mailbox, shown on white like most mail apps. */}
          <div className="rounded-lg bg-white p-5 text-[15px] text-neutral-900 [&_a]:text-blue-700 [&_a]:underline" style={{ ...emailStyleVars(style) }}>
            <div dangerouslySetInnerHTML={{ __html: preview }} />
          </div>
        </SettingsBlock>
      </SettingsSection>
    </>
  )
}

// ---------------------------------------------------------------- Agent

export function ClaudePage({ settings, onSaved }: { settings: PublicSettings | null; onSaved: (s: PublicSettings) => void }) {
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const [path, setPath] = useState(settings?.opencode.path ?? '')
  const [model, setModel] = useState(settings?.opencode.model ?? '')
  const [agent, setAgent] = useState(settings?.opencode.agent ?? '')
  const desktop = !!window.api
  const provider = settings?.aiProvider ?? 'claude'

  const test = async () => {
    if (!window.api) return
    setTesting(true)
    setStatus(null)
    try {
      const res = await window.api.claude.test()
      const message = !res.ok
        ? res.error
        : res.value.via === 'api-key'
          ? 'Connected with your API key.'
          : res.value.via === 'claude-login'
            ? 'Connected with your Claude sign-in.'
            : 'Connected with opencode.'
      setStatus({ ok: res.ok, message })
    } finally {
      setTesting(false)
    }
  }

  const setKey = async (key: string) => {
    if (!window.api) return
    setBusy(true)
    try {
      onSaved(await window.api.settings.set({ anthropicKey: key }))
      setApiKey('')
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  const setProvider = async (p: PublicSettings['aiProvider']) => {
    if (!window.api) return
    setStatus(null)
    onSaved(await window.api.settings.set({ aiProvider: p }))
  }

  const saveOpencode = async () => {
    if (!window.api) return
    setBusy(true)
    try {
      onSaved(await window.api.settings.set({ opencodePath: path, opencodeModel: model, opencodeAgent: agent }))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Intro>
        Inroad uses an AI agent to research each organisation, draft emails and power the chat. Choose which one to run — both use the same features and keep
        everything on your computer.
      </Intro>
      <SettingsSection title="Agent">
        <SettingsRow
          title="Provider"
          description={
            provider === 'opencode'
              ? 'Runs the opencode CLI installed on this computer, with your own model providers, through a read-only web agent.'
              : 'Uses your Claude Code sign-in, or an Anthropic API key if you set one.'
          }
        >
          <Choice
            value={provider}
            onChange={setProvider}
            options={[
              ['claude', 'Claude'],
              ['opencode', 'opencode'],
            ]}
          />
        </SettingsRow>
        <SettingsRow title="Connection" description="Checks the chosen provider is reachable on this computer.">
          <Button variant="outline" disabled={!desktop || testing} onClick={test}>
            {testing && <Loader2 className="animate-spin" />} Test connection
          </Button>
        </SettingsRow>
        {status && (
          <SettingsBlock>
            <StatusLine status={status} />
          </SettingsBlock>
        )}
      </SettingsSection>

      {provider === 'claude' ? (
        <>
          {settings && !settings.secureStorage && <InsecureStorageNotice />}
          <SettingsSection title="Claude connection">
            <SettingsRow
              title="Claude sign-in"
              description={
                <>
                  Not signed in? Run <code className="rounded bg-muted px-1 py-0.5 text-xs">claude</code> in a terminal once and log in.
                </>
              }
            />
          </SettingsSection>
          <SettingsSection title="API key (optional)">
            <SettingsRow
              title="Anthropic API key"
              description={
                <>
                  Used instead of your sign-in, billed per token. Create one at{' '}
                  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="underline">
                    console.anthropic.com
                  </a>
                  .
                </>
              }
              htmlFor="apiKey"
            >
              <Input
                id="apiKey"
                type="password"
                autoComplete="off"
                className="w-56"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={settings?.hasAnthropicKey ? 'Saved — type to replace' : 'sk-ant-…'}
              />
              <Button disabled={!desktop || busy || !apiKey.trim()} onClick={() => setKey(apiKey)}>
                Save
              </Button>
            </SettingsRow>
            {settings?.hasAnthropicKey && (
              <SettingsRow title="Using your API key" description="Remove it to go back to your Claude sign-in.">
                <Button variant="ghost" className="text-destructive" disabled={!desktop || busy} onClick={() => setKey('')}>
                  Remove key
                </Button>
              </SettingsRow>
            )}
          </SettingsSection>
        </>
      ) : (
        <SettingsSection title="opencode">
          <SettingsRow
            title="opencode path"
            description="Where the opencode executable is. Leave blank to use opencode from your PATH."
            htmlFor="opencodePath"
          >
            <Input id="opencodePath" className="w-56" value={path} onChange={(e) => setPath(e.target.value)} placeholder="opencode" />
          </SettingsRow>
          <SettingsRow
            title="Model"
            description="In provider/model form, e.g. anthropic/claude-sonnet-4-5. Blank uses your opencode default."
            htmlFor="opencodeModel"
          >
            <Input id="opencodeModel" className="w-56" value={model} onChange={(e) => setModel(e.target.value)} placeholder="(default)" />
          </SettingsRow>
          <SettingsRow
            title="Agent"
            description="The opencode agent to run. The default “inroad” agent is read-only and web-only, which suits Inroad's research and drafting."
            htmlFor="opencodeAgent"
          >
            <Input id="opencodeAgent" className="w-56" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="inroad" />
          </SettingsRow>
          <SettingsBlock>
            <Button disabled={!desktop || busy} onClick={saveOpencode}>
              Save
            </Button>
          </SettingsBlock>
        </SettingsSection>
      )}
    </>
  )
}

// ---------------------------------------------------------------- Appearance

export function AppearancePage({ theme, onTheme }: { theme: 'dark' | 'light'; onTheme: (t: 'dark' | 'light') => void }) {
  return (
    <SettingsSection title="Theme">
      <SettingsRow title="Colour theme">
        <Choice
          value={theme}
          onChange={onTheme}
          options={[
            ['dark', 'Dark'],
            ['light', 'Light'],
          ]}
        />
      </SettingsRow>
    </SettingsSection>
  )
}

// ---------------------------------------------------------------- Shortcuts

export function ShortcutsPage() {
  return (
    <>
      <Intro>Most of the time you’re typing, so everything important also has a ⌘ shortcut. Press ? anywhere to see these.</Intro>
      <ShortcutSection title="Anywhere, even while typing" items={globalShortcuts()} />
      <ShortcutSection title="When you’re not in a text box" items={NAV_SHORTCUTS} />
    </>
  )
}

function ShortcutSection({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <SettingsSection title={title}>
      {items.map(([k, label]) => (
        <SettingsRow key={k} title={<span className="font-normal">{label}</span>}>
          <Keys keys={k} />
        </SettingsRow>
      ))}
    </SettingsSection>
  )
}

// ---------------------------------------------------------------- Data

export function DataPage({ onReset }: { onReset: () => void }) {
  return (
    <SettingsSection title="Your data">
      <SettingsRow
        title="Start fresh"
        description="Permanently removes all folders, campaigns, organisations, emails, chats and voices, including Deleted items, then runs setup again. Your mailbox and AI agent settings stay, and nothing in your mailbox is touched."
      >
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">
              <Trash2 /> Start fresh…
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Start fresh?</AlertDialogTitle>
              <AlertDialogDescription>
                All folders, campaigns, organisations, emails, chats and voices will be deleted for good. This can’t be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={onReset}>
                Delete everything
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SettingsRow>
    </SettingsSection>
  )
}

export function Intro({ children }: { children: ReactNode }) {
  return <p className="px-1 text-sm text-muted-foreground">{children}</p>
}
