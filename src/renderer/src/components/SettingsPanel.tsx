import { Check, Database, Import as ImportIcon, RefreshCw, Server, SlidersHorizontal, UsersRound, X } from 'lucide-react'
import { useState } from 'react'
import type {
  AppSettings,
  PublicAgentRosterSnapshot,
  PublicSessionSnapshot
} from '../../../shared/models'
import type { PrivacyDisplayResolver } from '../../../shared/privacy'
import { AgentsSettings } from './AgentsSettings'
import { McpSettings } from './McpSettings'
import { SwiftImportSettings } from './SwiftImportSettings'
import { UpdateSettings } from './UpdateSettings'
import { GrokDoctorSettings } from './GrokDoctorSettings'
import { ModalSurface } from './ModalSurface'
import { MemorySettings } from './MemorySettings'

interface SettingsPanelProps {
  settings: AppSettings
  cliAvailable: boolean
  cliVersion?: string
  selectedProjectId?: string
  selectedProjectName?: string
  selectedProjectReady: boolean
  agentRoster: PublicAgentRosterSnapshot
  sessions: readonly PublicSessionSnapshot[]
  privacy: PrivacyDisplayResolver
  onClose: () => void
  onSave: (settings: Partial<AppSettings>) => void
  onChooseCli: () => void
}

export function SettingsPanel({
  settings,
  cliAvailable,
  cliVersion,
  selectedProjectId,
  selectedProjectName,
  selectedProjectReady,
  agentRoster,
  sessions,
  privacy,
  onClose,
  onSave,
  onChooseCli
}: SettingsPanelProps): React.JSX.Element {
  const [section, setSection] = useState<'application' | 'memory' | 'agents' | 'mcp' | 'updates' | 'import'>('application')
  return (
    <ModalSurface className="settings-dialog" labelledBy="settings-title" onClose={onClose}>
      <section className="settings-panel">
        <header>
          <div>
            <div className="card-eyebrow">GrokBuild</div>
            <h2 id="settings-title">Settings</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close settings" data-modal-initial-focus><X size={16} /></button>
        </header>
        <div className="settings-layout">
          <nav className="settings-navigation" aria-label="Settings sections">
            <button type="button" className={section === 'application' ? 'selected' : undefined} onClick={() => setSection('application')} aria-current={section === 'application' ? 'page' : undefined}>
              <SlidersHorizontal size={15} /> Application
            </button>
            <button type="button" className={section === 'agents' ? 'selected' : undefined} onClick={() => setSection('agents')} aria-current={section === 'agents' ? 'page' : undefined}>
              <UsersRound size={15} /> Agents
            </button>
            <button type="button" className={section === 'memory' ? 'selected' : undefined} onClick={() => setSection('memory')} aria-current={section === 'memory' ? 'page' : undefined}>
              <Database size={15} /> Memory
            </button>
            <button type="button" className={section === 'mcp' ? 'selected' : undefined} onClick={() => setSection('mcp')} aria-current={section === 'mcp' ? 'page' : undefined}>
              <Server size={15} /> MCP Servers
            </button>
            <button type="button" className={section === 'updates' ? 'selected' : undefined} onClick={() => setSection('updates')} aria-current={section === 'updates' ? 'page' : undefined}>
              <RefreshCw size={15} /> Updates
            </button>
            <button type="button" className={section === 'import' ? 'selected' : undefined} onClick={() => setSection('import')} aria-current={section === 'import' ? 'page' : undefined}>
              <ImportIcon size={15} /> Import
            </button>
          </nav>
          <div className="settings-sections">
            <section className="settings-content" hidden={section !== 'application'} aria-label="Application settings">
              <div className="settings-section-heading">
                <span className="settings-kicker">Application</span>
                <h3>Workspace behavior</h3>
                <p>Local display and process limits for this Mac.</p>
              </div>
              <label>
                Appearance
                <select value={settings.appearance} onChange={(event) => onSave({ appearance: event.target.value as AppSettings['appearance'] })}>
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
              <label className="switch-row">
                <span><strong>Privacy Mode</strong><small>Hide identifying workspace metadata on screen. Stored data is unchanged.</small></span>
                <input
                  type="checkbox"
                  checked={settings.privacyMode}
                  aria-label="Privacy Mode"
                  onChange={(event) => onSave({ privacyMode: event.target.checked })}
                />
              </label>
              <label className="switch-row">
                <span><strong>Reduce motion</strong><small>Disable nonessential interface transitions.</small></span>
                <input type="checkbox" checked={settings.reduceMotion} onChange={(event) => onSave({ reduceMotion: event.target.checked })} />
              </label>
              <label>
                Grok CLI path
                <div className="path-field">
                  <input value={privacy.path(settings.grokCliPath)} readOnly spellCheck={false} />
                  <button type="button" onClick={onChooseCli}>Choose…</button>
                </div>
              </label>
              <div className={`cli-status ${cliAvailable ? 'available' : 'missing'}`}>
                {cliAvailable ? <Check size={15} /> : <X size={15} />}
                <span>{cliAvailable ? `CLI ready${cliVersion ? ` · ${cliVersion}` : ''}` : 'CLI not found at this path'}</span>
              </div>
              <GrokDoctorSettings onCheck={window.grokbuild.checkDoctor} />
              <label>
                Live sessions
                <select value={settings.maxLiveSessions} onChange={(event) => onSave({ maxLiveSessions: Number(event.target.value) })}>
                  {[1, 2, 3, 4, 6, 8].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            </section>
            <section className="settings-memory-section" hidden={section !== 'memory'} aria-label="Memory settings">
              <MemorySettings
                active={section === 'memory'}
                memoryEnabled={settings.memoryEnabled}
                privacy={privacy}
                onApplySetting={window.grokbuild.updateSettings}
                onList={window.grokbuild.listMemory}
                onRead={window.grokbuild.readMemory}
                onRemember={window.grokbuild.rememberMemory}
                onDelete={window.grokbuild.deleteMemory}
              />
            </section>
            <section className="settings-agents-section" hidden={section !== 'agents'} aria-label="Agent settings">
              <AgentsSettings
                active={section === 'agents'}
                roster={agentRoster}
                sessions={sessions}
                cliAvailable={cliAvailable}
                workspaceReady={selectedProjectReady}
                privacy={privacy}
                {...(selectedProjectId ? { projectId: selectedProjectId } : {})}
                {...(selectedProjectName ? { projectName: selectedProjectName } : {})}
              />
            </section>
            <section className="settings-mcp-section" hidden={section !== 'mcp'} aria-label="MCP server settings">
              <McpSettings
                active={section === 'mcp'}
                cliAvailable={cliAvailable}
                {...(selectedProjectId ? { projectId: selectedProjectId } : {})}
                {...(selectedProjectName ? { projectName: selectedProjectName } : {})}
              />
            </section>
            <section className="settings-tool-section" hidden={section !== 'updates'} aria-label="Update settings">
              <UpdateSettings
                onCheck={() => window.grokbuild.checkUpdates()}
                onInstallAppUpdate={() => window.grokbuild.installAppUpdate()}
                onInstallCliUpdate={() => window.grokbuild.installCliUpdate()}
                onOpenAppRelease={() => window.grokbuild.openAppRelease()}
              />
            </section>
            <section className="settings-tool-section" hidden={section !== 'import'} aria-label="Swift state import">
              <SwiftImportSettings
                onPreview={() => window.grokbuild.previewSwiftImport()}
                onCommit={(token) => window.grokbuild.commitSwiftImport({ token })}
                onCancel={(token) => window.grokbuild.cancelSwiftImport({ token })}
              />
            </section>
          </div>
        </div>
      </section>
    </ModalSurface>
  )
}
