import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipcChannels'
import type { GrokBuildBridge } from '../shared/bridge'
import type { AppSnapshot } from '../shared/models'

const bridge: GrokBuildBridge = {
  bootstrap: () => ipcRenderer.invoke(IPC.bootstrap),
  chooseProject: () => ipcRenderer.invoke(IPC.chooseProject),
  chooseAttachments: (input) => ipcRenderer.invoke(IPC.chooseAttachments, input),
  captureClipboardImage: (input) => ipcRenderer.invoke(IPC.captureClipboardImage, input),
  copyText: (input) => ipcRenderer.invoke(IPC.copyText, input),
  showImageMenu: (input) => ipcRenderer.invoke(IPC.showImageMenu, input),
  cancelAttachments: (input) => ipcRenderer.invoke(IPC.cancelAttachments, input),
  chooseGrokCli: () => ipcRenderer.invoke(IPC.chooseGrokCli),
  createSession: (input) => ipcRenderer.invoke(IPC.createSession, input),
  createSavedAgent: (input) => ipcRenderer.invoke(IPC.createSavedAgent, input),
  updateSavedAgent: (input) => ipcRenderer.invoke(IPC.updateSavedAgent, input),
  deleteSavedAgent: (input) => ipcRenderer.invoke(IPC.deleteSavedAgent, input),
  installStarterAgents: (input) => ipcRenderer.invoke(IPC.installStarterAgents, input),
  recoverSavedAgentRoster: (input) => ipcRenderer.invoke(IPC.recoverSavedAgentRoster, input),
  bindSavedAgent: (input) => ipcRenderer.invoke(IPC.bindSavedAgent, input),
  listGrokAgentCatalog: (input) => ipcRenderer.invoke(IPC.listGrokAgentCatalog, input),
  selectProject: (input) => ipcRenderer.invoke(IPC.selectProject, input),
  selectSession: (input) => ipcRenderer.invoke(IPC.selectSession, input),
  removeProject: (input) => ipcRenderer.invoke(IPC.removeProject, input),
  moveProject: (input) => ipcRenderer.invoke(IPC.moveProject, input),
  inspectDashboardGit: () => ipcRenderer.invoke(IPC.inspectDashboardGit),
  listProjectOpenTargets: () => ipcRenderer.invoke(IPC.listProjectOpenTargets),
  openProject: (input) => ipcRenderer.invoke(IPC.openProject, input),
  closeSession: (input) => ipcRenderer.invoke(IPC.closeSession, input),
  duplicateSession: (input) => ipcRenderer.invoke(IPC.duplicateSession, input),
  forkSession: (input) => ipcRenderer.invoke(IPC.forkSession, input),
  setProjectPinned: (input) => ipcRenderer.invoke(IPC.setProjectPinned, input),
  setSessionPinned: (input) => ipcRenderer.invoke(IPC.setSessionPinned, input),
  setSessionSettled: (input) => ipcRenderer.invoke(IPC.setSessionSettled, input),
  setSessionUnread: (input) => ipcRenderer.invoke(IPC.setSessionUnread, input),
  listSessionHistory: () => ipcRenderer.invoke(IPC.listSessionHistory),
  searchSessionHistory: (input) => ipcRenderer.invoke(IPC.searchSessionHistory, input),
  openSessionHistory: (input) => ipcRenderer.invoke(IPC.openSessionHistory, input),
  deleteSessionHistory: (input) => ipcRenderer.invoke(IPC.deleteSessionHistory, input),
  sendPrompt: (input) => ipcRenderer.invoke(IPC.sendPrompt, input),
  cancelTurn: (input) => ipcRenderer.invoke(IPC.cancelTurn, input),
  retrySession: (input) => ipcRenderer.invoke(IPC.retrySession, input),
  answerPermission: (input) => ipcRenderer.invoke(IPC.answerPermission, input),
  answerInteraction: (input) => ipcRenderer.invoke(IPC.answerInteraction, input),
  updateSession: (input) => ipcRenderer.invoke(IPC.updateSession, input),
  updateSettings: (input) => ipcRenderer.invoke(IPC.updateSettings, input),
  listMemory: () => ipcRenderer.invoke(IPC.listMemory),
  readMemory: (input) => ipcRenderer.invoke(IPC.readMemory, input),
  rememberMemory: (input) => ipcRenderer.invoke(IPC.rememberMemory, input),
  deleteMemory: (input) => ipcRenderer.invoke(IPC.deleteMemory, input),
  listMcp: () => ipcRenderer.invoke(IPC.listMcp),
  addMcp: (input) => ipcRenderer.invoke(IPC.addMcp, input),
  removeMcp: (input) => ipcRenderer.invoke(IPC.removeMcp, input),
  enableMcp: (input) => ipcRenderer.invoke(IPC.enableMcp, input),
  disableMcp: (input) => ipcRenderer.invoke(IPC.disableMcp, input),
  doctorMcp: (input) => ipcRenderer.invoke(IPC.doctorMcp, input),
  checkDoctor: () => ipcRenderer.invoke(IPC.checkDoctor),
  checkAccount: () => ipcRenderer.invoke(IPC.checkAccount),
  checkUpdates: () => ipcRenderer.invoke(IPC.checkUpdates),
  installAppUpdate: () => ipcRenderer.invoke(IPC.installAppUpdate),
  installCliUpdate: () => ipcRenderer.invoke(IPC.installCliUpdate),
  openAppRelease: () => ipcRenderer.invoke(IPC.openAppRelease),
  previewSwiftImport: () => ipcRenderer.invoke(IPC.previewSwiftImport),
  commitSwiftImport: (input) => ipcRenderer.invoke(IPC.commitSwiftImport, input),
  cancelSwiftImport: (input) => ipcRenderer.invoke(IPC.cancelSwiftImport, input),
  onStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => listener(snapshot)
    ipcRenderer.on(IPC.stateChanged, handler)
    return () => ipcRenderer.removeListener(IPC.stateChanged, handler)
  },
  onOpenSettings: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC.openSettings, handler)
    return () => ipcRenderer.removeListener(IPC.openSettings, handler)
  }
}

contextBridge.exposeInMainWorld('grokbuild', Object.freeze(bridge))
