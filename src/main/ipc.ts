import {
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent
} from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join as joinPath } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import {
  IPC,
  answerPermissionInput,
  answerInteractionInput,
  cancelAttachmentsInput,
  cancelTurnInput,
  chooseAttachmentsInput,
  closeSessionInput,
  createSessionInput,
  createSavedAgentInput,
  updateSavedAgentInput,
  deleteSavedAgentInput,
  installStarterAgentsInput,
  recoverSavedAgentRosterInput,
  bindSavedAgentInput,
  listGrokAgentCatalogInput,
  savedAgentRosterRecoveryResultSchema,
  savedAgentDeleteResultSchema,
  duplicateSessionInput,
  forkSessionInput,
  moveProjectInput,
  noArgumentsInput,
  openProjectInput,
  openSessionHistoryInput,
  projectOpenResultSchema,
  projectOpenTargetStatusSchema,
  removeProjectInput,
  retrySessionInput,
  searchSessionHistoryInput,
  selectProjectInput,
  selectSessionInput,
  setProjectPinnedInput,
  setSessionPinnedInput,
  setSessionSettledInput,
  setSessionUnreadInput,
  deleteSessionHistoryInput,
  readMemoryInput,
  rememberMemoryInput,
  deleteMemoryInput,
  swiftImportTokenInput,
  sendPromptInput,
  updateSessionInput,
  updateSettingsInput
} from '../shared/ipc'
import {
  ForkSessionUnavailableError,
  SavedAgentOperationUnavailableError,
  SessionHistoryUnavailableError,
  type AppController
} from './AppController'
import {
  appSnapshotSchema,
  publicAgentRosterSnapshotSchema,
  publicSavedAgentSummarySchema,
  publicSessionSnapshotSchema
} from '../shared/schemas'
import { publicGrokAgentCatalogSchema } from '../shared/agentCatalog'
import { AgentRosterStoreError } from './agents/AgentRosterStore'
import { MAX_SAVED_AGENTS } from '../shared/agents'
import {
  swiftImportCommitResultSchema,
  swiftImportPreviewSchema
} from '../shared/swiftImport'
import {
  appUpdateInstallResultSchema,
  cliUpdateInstallResultSchema,
  updateOverviewSchema
} from '../shared/updates'
import { GrokCliService } from './grok/GrokCliService'
import { McpService } from './mcp/McpService'
import { SwiftStateImportBroker } from './migration/SwiftStateImportBroker'
import {
  UpdateCoordinator,
  type UpdateCheckResult
} from './updates/UpdateCoordinator'
import { AttachmentBrokerError } from './attachments/AttachmentBroker'
import {
  attachmentSelectionSummarySchema,
  type AttachmentSelectionSummary
} from '../shared/attachments'
import { grokDoctorReportSchema } from '../shared/doctor'
import { dashboardProjectStatusSchema } from '../shared/dashboard'
import {
  publicSessionHistoryRecordsSchema,
  sessionHistoryDeleteResultSchema
} from '../shared/sessionHistory'
import { SessionHistoryBrokerError } from './history/SessionHistoryBroker'
import {
  memoryDeleteResultSchema,
  publicMemoryFileContentsSchema,
  publicMemoryFileSummariesSchema
} from '../shared/memory'
import { GrokDoctorService } from './grok/GrokDoctorService'
import { GrokAccountService } from './grok/GrokAccountService'
import { grokAccountReportSchema } from '../shared/account'
import { publicAcpErrorMessage } from './acp/PublicSessionError'
import { WorkspaceUnavailableError } from './workspaces/WorkspaceHealthService'
import {
  ProjectOpenService,
  ProjectOpenServiceError
} from './workspaces/ProjectOpenService'

export interface IpcIntegrationOptions {
  updateFeedUrl?: string | undefined
  swiftImportBroker?: SwiftStateImportBroker | undefined
  doctorService?: GrokDoctorService | undefined
  accountService?: Pick<GrokAccountService, 'inspect'> | undefined
  openExternal?: ((url: string) => Promise<void>) | undefined
  readCliVersion?: ((cliPath: string) => Promise<string | undefined>) | undefined
  projectOpenService?: Pick<ProjectOpenService, 'listTargets' | 'openProject'> | undefined
  appUpdateCoordinator?: {
    check(cwd?: string): Promise<UpdateCheckResult>
    installApp(): Promise<'cancelled' | 'restarting'>
  } | undefined
  cliUpdateCoordinator?: {
    installCli(): Promise<
      | { state: 'cancelled' }
      | {
          state: 'installed'
          current: string
          latest: string
          updateAvailable: boolean
          channel?: string | undefined
        }
    >
  } | undefined
}

export function registerIpc(
  controller: AppController,
  window: BrowserWindow,
  trustedDevelopmentOrigin?: string,
  integration: IpcIntegrationOptions = {}
): () => void {
  const swiftImportBroker = integration.swiftImportBroker ?? new SwiftStateImportBroker()
  const doctorService = integration.doctorService ?? new GrokDoctorService()
  const accountService = integration.accountService ?? new GrokAccountService()
  const updateFeedUrl = integration.updateFeedUrl?.trim() || undefined
  const openExternal = integration.openExternal ?? ((url: string) => shell.openExternal(url))
  const projectOpenService = integration.projectOpenService ?? new ProjectOpenService()
  let cachedAppReleaseUrl: string | undefined
  let updateCheckSequence = 0
  const validSender = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Rejected IPC from an untrusted frame')
    }
    const frameUrl = new URL(event.senderFrame.url)
    const trusted =
      (frameUrl.protocol === 'grokbuild:' && frameUrl.hostname === 'app') ||
      (trustedDevelopmentOrigin !== undefined && frameUrl.origin === trustedDevelopmentOrigin)
    if (!trusted) throw new Error('Rejected IPC from an untrusted origin')
  }

  ipcMain.handle(IPC.bootstrap, (event) => {
    validSender(event)
    return appSnapshotSchema.parse(controller.snapshot())
  })
  ipcMain.handle(IPC.chooseProject, async (event) => {
    validSender(event)
    const result = await dialog.showOpenDialog(window, {
      title: 'Add a project',
      properties: ['openDirectory', 'createDirectory']
    })
    const path = result.filePaths[0]
    return path ? controller.addProject(path) : null
  })
  ipcMain.handle(IPC.chooseAttachments, async (event, raw) => {
    validSender(event)
    const { sessionId } = chooseAttachmentsInput.parse(raw)
    try {
      await controller.prepareAttachments(sessionId)
    } catch (error) {
      throw publicAttachmentError(error)
    }
    const result = await dialog.showOpenDialog(window, {
      title: 'Attach files',
      buttonLabel: 'Attach',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    try {
      const summary = attachmentSelectionSummarySchema.parse(withImagePreviews(
        await controller.stageAttachments(sessionId, result.filePaths),
        result.filePaths
      ))
      controller.rememberAttachmentDisplayItems(summary.token, summary.attachments)
      return summary
    } catch (error) {
      throw publicAttachmentError(error)
    }
  })
  ipcMain.handle(IPC.captureClipboardImage, async (event, raw) => {
    validSender(event)
    const { sessionId } = chooseAttachmentsInput.parse(raw)
    try {
      await controller.prepareAttachments(sessionId)
    } catch (error) {
      throw publicAttachmentError(error)
    }
    const image = clipboard.readImage()
    if (image.isEmpty()) return null
    // The pasted bitmap becomes an owner-only temp file so it can ride the
    // exact staging pipeline (sniffing, limits, leases) the file dialog uses.
    // The file must outlive the lease: the broker's stability check folds
    // ctime into the file identity, and an early unlink bumps ctime, so the
    // send would fail as tampered. Cleanup instead happens here for pastes
    // older than an hour (lease TTL is five minutes), with macOS temp
    // reaping as the backstop. The random segment lives in the directory
    // name so the chip label stays human-readable.
    await sweepStalePasteDirectories()
    const temporaryDirectory = joinPath(app.getPath('temp'), `grokbuild-paste-${randomUUID()}`)
    const temporaryPath = joinPath(temporaryDirectory, 'Pasted image.png')
    try {
      await mkdir(temporaryDirectory, { mode: 0o700 })
      await writeFile(temporaryPath, image.toPNG(), { mode: 0o600 })
      const summary = attachmentSelectionSummarySchema.parse(withImagePreviews(
        await controller.stageAttachments(sessionId, [temporaryPath]),
        [temporaryPath]
      ))
      controller.rememberAttachmentDisplayItems(summary.token, summary.attachments)
      return summary
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
      throw publicAttachmentError(error)
    }
  })
  ipcMain.handle(IPC.cancelAttachments, async (event, raw) => {
    validSender(event)
    const { sessionId, token } = cancelAttachmentsInput.parse(raw)
    await controller.cancelAttachments(sessionId, token)
  })
  ipcMain.handle(IPC.chooseGrokCli, async (event) => {
    validSender(event)
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose the Grok CLI',
      buttonLabel: 'Use Grok CLI',
      properties: ['openFile']
    })
    const path = result.filePaths[0]
    if (!path) return null
    return await withIntegrationOperation(controller, async () => {
      const selectedPath = await controller.setGrokCliPath(path)
      const version = await integration.readCliVersion?.(selectedPath).catch(() => undefined)
      controller.setCliVersion(selectedPath, version)
      return selectedPath
    })
  })
  ipcMain.handle(IPC.createSession, async (event, raw) => {
    validSender(event)
    const created = await controller.createSession(createSessionInput.parse(raw).projectId)
    return publicSessionResult(controller, created.id)
  })
  ipcMain.handle(IPC.createSavedAgent, async (event, raw) => {
    validSender(event)
    try {
      const input = createSavedAgentInput.parse(raw)
      return publicSavedAgentSummarySchema.parse(
        await controller.createSavedAgent(input.expectedRevision, input.draft)
      )
    } catch (error) {
      throw publicSavedAgentIpcError(error)
    }
  })
  ipcMain.handle(IPC.updateSavedAgent, async (event, raw) => {
    validSender(event)
    try {
      const input = updateSavedAgentInput.parse(raw)
      const agent = publicSavedAgentSummarySchema.parse(
        await controller.updateSavedAgentEditor(
          input.expectedRevision,
          input.agentId,
          input.changes
        )
      )
      if (agent.id !== input.agentId) throw new SavedAgentOperationUnavailableError()
      return agent
    } catch (error) {
      throw publicSavedAgentIpcError(error)
    }
  })
  ipcMain.handle(IPC.deleteSavedAgent, async (event, raw) => {
    validSender(event)
    try {
      const input = deleteSavedAgentInput.parse(raw)
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Delete saved agent?',
        message: 'Delete this saved agent?',
        detail: 'Existing chats will stay. Saved bindings to this agent will be removed.',
        buttons: ['Cancel', 'Delete Agent'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (confirmation.response !== 1) {
        return savedAgentDeleteResultSchema.parse({ state: 'cancelled' })
      }
      await controller.deleteSavedAgent(input.expectedRevision, input.agentId)
      return savedAgentDeleteResultSchema.parse({ state: 'deleted' })
    } catch (error) {
      throw publicSavedAgentIpcError(error)
    }
  })
  ipcMain.handle(IPC.installStarterAgents, async (event, raw) => {
    validSender(event)
    try {
      const input = installStarterAgentsInput.parse(raw)
      const agents = await controller.installStarterAgents(input.expectedRevision)
      return z.array(publicSavedAgentSummarySchema).max(MAX_SAVED_AGENTS).parse(agents)
    } catch (error) {
      throw publicSavedAgentIpcError(error)
    }
  })
  ipcMain.handle(IPC.recoverSavedAgentRoster, async (event, raw) => {
    validSender(event)
    try {
      const input = recoverSavedAgentRosterInput.parse(raw)
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Recover saved agents?',
        message: 'Recover saved agents?',
        detail: 'The invalid saved-agent roster will be moved aside and replaced with an empty roster. Existing chats will stay.',
        buttons: ['Cancel', 'Recover'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (confirmation.response !== 1) {
        return savedAgentRosterRecoveryResultSchema.parse({ state: 'cancelled' })
      }
      const roster = publicAgentRosterSnapshotSchema.parse(
        await controller.recoverSavedAgentRoster(input.expectedRevision)
      )
      if (roster.status !== 'ready') throw new SavedAgentOperationUnavailableError()
      return savedAgentRosterRecoveryResultSchema.parse({ state: 'recovered', roster })
    } catch (error) {
      throw publicSavedAgentIpcError(error)
    }
  })
  ipcMain.handle(IPC.bindSavedAgent, async (event, raw) => {
    validSender(event)
    try {
      const input = bindSavedAgentInput.parse(raw)
      const session = publicSessionSnapshotSchema.parse(await controller.bindSavedAgent(
        input.sessionId,
        input.agentId,
        input.expectedRevision
      ))
      if (session.id !== input.sessionId) throw new SavedAgentOperationUnavailableError()
      return session
    } catch (error) {
      throw publicSavedAgentIpcError(error)
    }
  })
  ipcMain.handle(IPC.listGrokAgentCatalog, async (event, raw) => {
    validSender(event)
    try {
      const input = listGrokAgentCatalogInput.parse(raw)
      return publicGrokAgentCatalogSchema.parse(
        await controller.listGrokAgentCatalog(input.projectId)
      )
    } catch {
      throw new Error('The Grok agent catalog could not be loaded safely.')
    }
  })
  ipcMain.handle(IPC.selectProject, (event, raw) => {
    validSender(event)
    return controller.selectProject(selectProjectInput.parse(raw).projectId)
  })
  ipcMain.handle(IPC.selectSession, (event, raw) => {
    validSender(event)
    return controller.selectSession(selectSessionInput.parse(raw).sessionId)
  })
  ipcMain.handle(IPC.removeProject, async (event, raw) => {
    validSender(event)
    await controller.removeProject(removeProjectInput.parse(raw).projectId)
  })
  ipcMain.handle(IPC.moveProject, (event, raw) => {
    validSender(event)
    const input = moveProjectInput.parse(raw)
    controller.moveProject(input.projectId, input.direction)
  })
  ipcMain.handle(IPC.inspectDashboardGit, async (event, ...rawArguments) => {
    validSender(event)
    try {
      noArgumentsInput.parse(rawArguments)
      return dashboardProjectStatusSchema.parse(await controller.inspectDashboardGit())
    } catch {
      // Controller, Git, workspace, and injected diagnostics must not cross IPC.
      throw new Error('Could not inspect the selected project.')
    }
  })
  ipcMain.handle(IPC.listProjectOpenTargets, async (event, ...rawArguments) => {
    validSender(event)
    noArgumentsInput.parse(rawArguments)
    try {
      const targets = await projectOpenService.listTargets()
      return targets.map((target) => projectOpenTargetStatusSchema.parse(target))
    } catch {
      throw new Error('Could not inspect project-open targets.')
    }
  })
  ipcMain.handle(IPC.openProject, async (event, raw) => {
    validSender(event)
    const input = openProjectInput.parse(raw)
    const project = controller.snapshot().projects.find(
      (candidate) => candidate.id === input.projectId
    )
    if (!project) throw new Error('Project is no longer available.')
    try {
      const opened = await projectOpenService.openProject(project.path, input.target)
      return projectOpenResultSchema.parse({ target: opened.target, opened: true })
    } catch (error) {
      throw new Error(
        error instanceof ProjectOpenServiceError
          ? error.message
          : 'Could not open the project.'
      )
    }
  })
  ipcMain.handle(IPC.closeSession, async (event, raw) => {
    validSender(event)
    await controller.closeSession(closeSessionInput.parse(raw).sessionId)
  })
  ipcMain.handle(IPC.duplicateSession, async (event, raw) => {
    validSender(event)
    const duplicated = await controller.duplicateSession(duplicateSessionInput.parse(raw).sessionId)
    return publicSessionResult(controller, duplicated.id)
  })
  ipcMain.handle(IPC.forkSession, async (event, raw) => {
    validSender(event)
    try {
      const forked = await controller.forkSession(forkSessionInput.parse(raw).sessionId)
      return publicSessionResult(controller, forked.id)
    } catch (error) {
      if (error instanceof WorkspaceUnavailableError || error instanceof ForkSessionUnavailableError) {
        throw new Error(error.message)
      }
      throw new Error(publicAcpErrorMessage(error))
    }
  })
  ipcMain.handle(IPC.setProjectPinned, (event, raw) => {
    validSender(event)
    const input = setProjectPinnedInput.parse(raw)
    controller.setProjectPinned(input.projectId, input.pinned)
  })
  ipcMain.handle(IPC.setSessionPinned, (event, raw) => {
    validSender(event)
    const input = setSessionPinnedInput.parse(raw)
    controller.setSessionPinned(input.sessionId, input.pinned)
  })
  ipcMain.handle(IPC.setSessionSettled, (event, raw) => {
    validSender(event)
    const input = setSessionSettledInput.parse(raw)
    controller.setSessionSettled(input.sessionId, input.settled)
  })
  ipcMain.handle(IPC.setSessionUnread, (event, raw) => {
    validSender(event)
    const input = setSessionUnreadInput.parse(raw)
    controller.setSessionUnread(input.sessionId, input.unread)
  })
  ipcMain.handle(IPC.listSessionHistory, async (event, ...rawArguments) => {
    validSender(event)
    try {
      noArgumentsInput.parse(rawArguments)
      return publicSessionHistoryRecordsSchema.parse(await controller.listSessionHistory())
    } catch (error) {
      throw publicSessionHistoryIpcError(error)
    }
  })
  ipcMain.handle(IPC.searchSessionHistory, async (event, raw) => {
    validSender(event)
    try {
      const { query } = searchSessionHistoryInput.parse(raw)
      return publicSessionHistoryRecordsSchema.parse(
        await controller.searchSessionHistory(query)
      )
    } catch (error) {
      throw publicSessionHistoryIpcError(error)
    }
  })
  ipcMain.handle(IPC.openSessionHistory, async (event, raw) => {
    validSender(event)
    try {
      const { token } = openSessionHistoryInput.parse(raw)
      return publicSessionSnapshotSchema.parse(await controller.openSessionHistory(token))
    } catch (error) {
      throw publicSessionHistoryIpcError(error)
    }
  })
  ipcMain.handle(IPC.deleteSessionHistory, async (event, raw) => {
    validSender(event)
    try {
      const { token } = deleteSessionHistoryInput.parse(raw)
      const result = await controller.deleteSessionHistory(token, async (summary) => {
        const privacyMode = controller.snapshot().settings.privacyMode
        const confirmation = await dialog.showMessageBox(window, {
          type: 'warning',
          title: 'Delete Grok session?',
          message: 'Delete this Grok session from Grok CLI history?',
          detail: privacyMode
            ? 'This saved session will be deleted from Grok CLI history.'
            : summary,
          buttons: ['Cancel', 'Delete Session'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        return confirmation.response === 1
      })
      return sessionHistoryDeleteResultSchema.parse(result)
    } catch (error) {
      throw publicSessionHistoryIpcError(error)
    }
  })
  ipcMain.handle(IPC.sendPrompt, async (event, raw) => {
    validSender(event)
    const input = sendPromptInput.parse(raw)
    try {
      await controller.sendPrompt(input.sessionId, input.text, input.attachmentToken)
    } catch (error) {
      throw publicAttachmentError(error)
    }
  })
  ipcMain.handle(IPC.cancelTurn, (event, raw) => {
    validSender(event)
    controller.cancelTurn(cancelTurnInput.parse(raw).sessionId)
  })
  ipcMain.handle(IPC.retrySession, async (event, raw) => {
    validSender(event)
    const { sessionId } = retrySessionInput.parse(raw)
    try {
      await controller.retrySession(sessionId)
    } catch (error) {
      if (error instanceof WorkspaceUnavailableError) throw new Error(error.message)
      throw new Error(publicAcpErrorMessage(error))
    }
  })
  ipcMain.handle(IPC.answerPermission, async (event, raw) => {
    validSender(event)
    const input = answerPermissionInput.parse(raw)
    await controller.answerPermission(input.sessionId, input.requestId, input.optionId)
  })
  ipcMain.handle(IPC.answerInteraction, async (event, raw) => {
    validSender(event)
    const input = answerInteractionInput.parse(raw)
    await controller.answerInteraction(input.sessionId, input.interactionId, input.answer)
  })
  ipcMain.handle(IPC.updateSession, (event, raw) => {
    validSender(event)
    controller.updateSession(updateSessionInput.parse(raw))
  })
  ipcMain.handle(IPC.updateSettings, async (event, raw) => {
    validSender(event)
    const input = updateSettingsInput.parse(raw)
    try {
      await controller.updateSettings(input)
    } finally {
      if (
        input.appearance &&
        controller.snapshot().settings.appearance === input.appearance
      ) nativeTheme.themeSource = input.appearance
    }
  })
  ipcMain.handle(IPC.listMemory, async (event, ...rawArguments) => {
    validSender(event)
    try {
      noArgumentsInput.parse(rawArguments)
      return publicMemoryFileSummariesSchema.parse(await controller.listMemory())
    } catch (error) {
      throw publicMemoryIpcError(error)
    }
  })
  ipcMain.handle(IPC.readMemory, async (event, ...rawArguments) => {
    validSender(event)
    try {
      const [raw] = z.tuple([z.unknown()]).parse(rawArguments)
      const { token } = readMemoryInput.parse(raw)
      return publicMemoryFileContentsSchema.parse(await controller.readMemory(token))
    } catch (error) {
      throw publicMemoryIpcError(error)
    }
  })
  ipcMain.handle(IPC.rememberMemory, async (event, ...rawArguments) => {
    validSender(event)
    try {
      const [raw] = z.tuple([z.unknown()]).parse(rawArguments)
      const { note } = rememberMemoryInput.parse(raw)
      await controller.rememberMemory(note)
    } catch (error) {
      throw publicMemoryIpcError(error)
    }
  })
  ipcMain.handle(IPC.deleteMemory, async (event, ...rawArguments) => {
    validSender(event)
    try {
      const [raw] = z.tuple([z.unknown()]).parse(rawArguments)
      const { token } = deleteMemoryInput.parse(raw)
      const confirmation = await dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Delete session memory?',
        message: 'Permanently delete this session memory entry?',
        detail: 'This action removes one per-session memory entry and cannot be undone.',
        buttons: ['Cancel', 'Delete Memory'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (confirmation.response !== 1) {
        return memoryDeleteResultSchema.parse({ state: 'cancelled' })
      }
      await controller.deleteMemory(token)
      return memoryDeleteResultSchema.parse({ state: 'deleted' })
    } catch (error) {
      throw publicMemoryIpcError(error)
    }
  })
  ipcMain.handle(IPC.listMcp, async (event) => {
    validSender(event)
    return await withIntegrationOperation(controller, async () => {
      const context = selectedMcpContext(controller)
      return await context.service.list({ cwd: context.cwd })
    })
  })
  ipcMain.handle(IPC.addMcp, async (event, raw) => {
    validSender(event)
    return await withIntegrationOperation(controller, async () => {
      const context = selectedMcpContext(controller)
      return await context.service.add(withSelectedCwd(raw, context.cwd))
    })
  })
  ipcMain.handle(IPC.removeMcp, async (event, raw) => {
    validSender(event)
    return await withIntegrationOperation(controller, async () => {
      const context = selectedMcpContext(controller)
      return await context.service.remove(withSelectedCwd(raw, context.cwd))
    })
  })
  ipcMain.handle(IPC.enableMcp, async (event, raw) => {
    validSender(event)
    return await withIntegrationOperation(controller, async () => {
      const context = selectedMcpContext(controller)
      return await context.service.enable(withSelectedCwd(raw, context.cwd))
    })
  })
  ipcMain.handle(IPC.disableMcp, async (event, raw) => {
    validSender(event)
    return await withIntegrationOperation(controller, async () => {
      const context = selectedMcpContext(controller)
      return await context.service.disable(withSelectedCwd(raw, context.cwd))
    })
  })
  ipcMain.handle(IPC.doctorMcp, async (event, raw) => {
    validSender(event)
    return await withIntegrationOperation(controller, async () => {
      const context = selectedMcpContext(controller)
      return await context.service.doctor(withSelectedCwd(raw, context.cwd))
    })
  })
  ipcMain.handle(IPC.checkDoctor, async (event, ...rawArguments) => {
    validSender(event)
    noArgumentsInput.parse(rawArguments)
    try {
      return await withIntegrationOperation(controller, async () => {
        const snapshot = controller.snapshot()
        return grokDoctorReportSchema.parse(await doctorService.inspect({
          cliAvailable: snapshot.cli.available,
          ...(snapshot.cli.version ? { cliVersion: snapshot.cli.version } : {})
        }))
      })
    } catch {
      throw new Error('Could not check Grok status.')
    }
  })
  ipcMain.handle(IPC.checkAccount, async (event, ...rawArguments) => {
    validSender(event)
    noArgumentsInput.parse(rawArguments)
    try {
      return grokAccountReportSchema.parse(await accountService.inspect())
    } catch {
      throw new Error('Could not check account status.')
    }
  })
  ipcMain.handle(IPC.checkUpdates, async (event, ...rawArguments) => {
    validSender(event)
    noArgumentsInput.parse(rawArguments)
    const sequence = ++updateCheckSequence
    cachedAppReleaseUrl = undefined
    const snapshot = controller.snapshot()
    const project = snapshot.projects.find((candidate) => candidate.id === snapshot.selectedProjectId)
    const coordinator = integration.appUpdateCoordinator ?? new UpdateCoordinator({
      appVersion: snapshot.appVersion,
      productAssetStem: 'GrokBuild-Electron',
      ...(updateFeedUrl ? { releasesUrl: updateFeedUrl } : {}),
      ...(snapshot.cli.available
        ? { cli: new GrokCliService({ cliPath: snapshot.settings.grokCliPath }) }
        : {})
    })
    const checked = await coordinator.check(project?.path ?? homedir())
    if (sequence === updateCheckSequence) {
      cachedAppReleaseUrl = safeReleaseUrl(checked.appReleaseUrl)
    }
    return updateOverviewSchema.parse(checked.overview)
  })
  ipcMain.handle(IPC.installAppUpdate, async (event, ...rawArguments) => {
    validSender(event)
    noArgumentsInput.parse(rawArguments)
    const coordinator = integration.appUpdateCoordinator
    if (!coordinator) throw new Error('Trusted app update installation is unavailable.')
    try {
      return appUpdateInstallResultSchema.parse({ state: await coordinator.installApp() })
    } catch {
      throw new Error('The app update could not be installed safely.')
    }
  })
  ipcMain.handle(IPC.installCliUpdate, async (event, ...rawArguments) => {
    validSender(event)
    noArgumentsInput.parse(rawArguments)
    const coordinator = integration.cliUpdateCoordinator
    if (!coordinator) throw new Error('Trusted Grok CLI update installation is unavailable.')
    try {
      return cliUpdateInstallResultSchema.parse(await coordinator.installCli())
    } catch {
      throw new Error('The Grok CLI update could not be installed safely.')
    }
  })
  ipcMain.handle(IPC.openAppRelease, async (event, ...rawArguments) => {
    validSender(event)
    noArgumentsInput.parse(rawArguments)
    const releaseUrl = cachedAppReleaseUrl
    if (!releaseUrl) throw new Error('Check for an app release before opening it.')
    try {
      await openExternal(releaseUrl)
    } catch {
      throw new Error('Could not open the app release page.')
    }
  })
  ipcMain.handle(IPC.previewSwiftImport, async (event, ...rawArguments) => {
    validSender(event)
    noArgumentsInput.parse(rawArguments)
    try {
      const result = await dialog.showOpenDialog(window, {
        title: 'Import from GrokBuild for Swift',
        buttonLabel: 'Preview Import',
        properties: ['openFile'],
        filters: [{ name: 'Property List', extensions: ['plist'] }]
      })
      const path = result.filePaths[0]
      if (!path) return null
      return await withIntegrationOperation(controller, async () =>
        swiftImportPreviewSchema.parse(
          await swiftImportBroker.preview(path, controller.migrationSnapshot())
        )
      )
    } catch {
      throw new Error('Could not preview the Swift state import.')
    }
  })
  ipcMain.handle(IPC.commitSwiftImport, async (event, raw) => {
    validSender(event)
    const { token } = swiftImportTokenInput.parse(raw)
    let merged
    try {
      merged = swiftImportBroker.consume(token, controller.migrationSnapshot())
    } catch {
      throw new Error('The Swift import preview expired; preview it again.')
    }
    try {
      await controller.applyMigrationState(merged.state)
      return swiftImportCommitResultSchema.parse({ merge: merged.summary })
    } catch {
      throw new Error('Could not commit the Swift state import.')
    }
  })
  ipcMain.handle(IPC.cancelSwiftImport, (event, raw) => {
    validSender(event)
    const { token } = swiftImportTokenInput.parse(raw)
    swiftImportBroker.cancel(token)
  })

  const channels = Object.values(IPC).filter((channel) => channel !== IPC.stateChanged)
  return () => {
    updateCheckSequence += 1
    cachedAppReleaseUrl = undefined
    swiftImportBroker.clear()
    channels.forEach((channel) => ipcMain.removeHandler(channel))
  }
}

const PREVIEW_HEIGHT = 96
const MAX_PREVIEW_CHARS = 200_000

/**
 * Bounded display thumbnails for staged images, generated in main from the
 * selected paths. The renderer receives only this downscaled re-encode, never
 * the original bytes. Matching is by display name in selection order, so a
 * dropped duplicate simply loses its preview rather than borrowing another.
 */
function withImagePreviews(
  summary: AttachmentSelectionSummary,
  selectedPaths: readonly string[]
): AttachmentSelectionSummary {
  const remaining = [...selectedPaths]
  return {
    ...summary,
    attachments: summary.attachments.map((attachment) => {
      if (attachment.kind !== 'image') return attachment
      const index = remaining.findIndex((path) => basename(path) === attachment.displayName)
      if (index < 0) return attachment
      const [path] = remaining.splice(index, 1)
      try {
        const image = nativeImage.createFromPath(path!)
        if (image.isEmpty()) return attachment
        const size = image.getSize()
        const preview = (size.height > PREVIEW_HEIGHT
          ? image.resize({ height: PREVIEW_HEIGHT })
          : image
        ).toDataURL()
        if (preview.length > MAX_PREVIEW_CHARS || !preview.startsWith('data:image/')) {
          return attachment
        }
        return { ...attachment, preview }
      } catch {
        return attachment
      }
    })
  }
}

/** Remove pasted-image temp directories once their lease can no longer exist. */
async function sweepStalePasteDirectories(): Promise<void> {
  const temporaryRoot = app.getPath('temp')
  const staleBeforeMs = Date.now() - 60 * 60_000
  const names = await readdir(temporaryRoot).catch(() => [] as string[])
  await Promise.all(names
    .filter((name) => name.startsWith('grokbuild-paste-'))
    .map(async (name) => {
      const path = joinPath(temporaryRoot, name)
      const info = await stat(path).catch(() => undefined)
      if (!info || info.mtimeMs >= staleBeforeMs) return
      await rm(path, { recursive: true, force: true }).catch(() => undefined)
    }))
}

async function withIntegrationOperation<T>(
  controller: AppController,
  operation: () => T | Promise<T>
): Promise<T> {
  const lease = controller.acquireIntegrationOperation()
  try {
    return await operation()
  } finally {
    lease.release()
  }
}

function selectedMcpContext(controller: AppController): {
  cwd: string
  service: McpService
} {
  const snapshot = controller.snapshot()
  const project = snapshot.projects.find((candidate) => candidate.id === snapshot.selectedProjectId)
  if (!project) throw new Error('Select a project before managing MCP servers')
  return {
    cwd: project.path,
    service: new McpService(new GrokCliService({ cliPath: snapshot.settings.grokCliPath }))
  }
}

function publicSessionResult(controller: AppController, sessionId: string): unknown {
  const session = controller.snapshot().sessions.find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error('Session is no longer available')
  return publicSessionSnapshotSchema.parse(session)
}

function withSelectedCwd(raw: unknown, cwd: string): Record<string, unknown> {
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  // Renderer input can never override cwd; it is derived from the selected project.
  return { ...input, cwd }
}

function safeReleaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function publicAttachmentError(error: unknown): Error {
  if (error instanceof AttachmentBrokerError) return new Error(error.message)
  if (error instanceof WorkspaceUnavailableError) return new Error(error.message)
  return new Error('The attachment request could not be completed.')
}

function publicSessionHistoryIpcError(error: unknown): Error {
  if (
    error instanceof SessionHistoryBrokerError ||
    error instanceof SessionHistoryUnavailableError
  ) return new Error(error.message)
  return new Error('The session history request could not be completed safely.')
}

function publicSavedAgentIpcError(error: unknown): Error {
  if (
    error instanceof SavedAgentOperationUnavailableError ||
    error instanceof AgentRosterStoreError
  ) return new Error('Saved agents changed or are unavailable. Refresh and try again.')
  return new Error('The saved agent request could not be completed safely.')
}

function publicMemoryIpcError(_error: unknown): Error {
  return new Error('The memory request could not be completed safely.')
}
