import type {
  AnswerPermissionInput,
  AnswerInteractionInput,
  AddMcpInput,
  CancelTurnInput,
  CancelAttachmentsInput,
  CloseSessionInput,
  ChooseAttachmentsInput,
  CreateSessionInput,
  CreateSavedAgentInput,
  UpdateSavedAgentInput,
  DeleteSavedAgentInput,
  InstallStarterAgentsInput,
  RecoverSavedAgentRosterInput,
  BindSavedAgentInput,
  ListGrokAgentCatalogInput,
  SavedAgentRosterRecoveryResult,
  SavedAgentDeleteResult,
  DisableMcpInput,
  DoctorMcpInput,
  DuplicateSessionInput,
  ForkSessionInput,
  EnableMcpInput,
  MoveProjectInput,
  OpenProjectInput,
  ProjectOpenResult,
  ProjectOpenTargetStatus,
  RemoveMcpInput,
  RemoveProjectInput,
  RetrySessionInput,
  SelectProjectInput,
  SelectSessionInput,
  SetProjectPinnedInput,
  SetSessionPinnedInput,
  SetSessionSettledInput,
  SetSessionUnreadInput,
  SearchSessionHistoryInput,
  OpenSessionHistoryInput,
  DeleteSessionHistoryInput,
  ReadMemoryInput,
  DeleteMemoryInput,
  RememberMemoryInput,
  SwiftImportTokenInput,
  SendPromptInput,
  UpdateSessionInput,
  UpdateSettingsInput
} from './ipc'
import type { AttachmentSelectionSummary } from './attachments'
import type { GrokDoctorReport } from './doctor'
import type { GrokAccountReport } from './account'
import type { DashboardProjectStatus } from './dashboard'
import type {
  PublicSessionHistoryRecord,
  SessionHistoryDeleteResult
} from './sessionHistory'
import type { McpDoctorResult, McpListResult, McpMutationResult } from './mcp'
import type { AppSnapshot, ProjectSnapshot, PublicSessionSnapshot } from './models'
import type { PublicSavedAgentSummary } from './models'
import type { PublicGrokAgentCatalog } from './agentCatalog'
import type {
  MemoryDeleteResult,
  PublicMemoryFileContents,
  PublicMemoryFileSummary
} from './memory'
import type {
  SwiftImportCommitResult,
  SwiftImportPreview
} from './swiftImport'
import type {
  AppUpdateInstallResult,
  CliUpdateInstallResult,
  UpdateOverview
} from './updates'

export interface GrokBuildBridge {
  bootstrap: () => Promise<AppSnapshot>
  chooseProject: () => Promise<ProjectSnapshot | null>
  chooseAttachments: (input: ChooseAttachmentsInput) => Promise<AttachmentSelectionSummary | null>
  captureClipboardImage: (input: ChooseAttachmentsInput) => Promise<AttachmentSelectionSummary | null>
  cancelAttachments: (input: CancelAttachmentsInput) => Promise<void>
  chooseGrokCli: () => Promise<string | null>
  createSession: (input: CreateSessionInput) => Promise<PublicSessionSnapshot>
  createSavedAgent: (input: CreateSavedAgentInput) => Promise<PublicSavedAgentSummary>
  updateSavedAgent: (input: UpdateSavedAgentInput) => Promise<PublicSavedAgentSummary>
  deleteSavedAgent: (input: DeleteSavedAgentInput) => Promise<SavedAgentDeleteResult>
  installStarterAgents: (input: InstallStarterAgentsInput) => Promise<PublicSavedAgentSummary[]>
  recoverSavedAgentRoster: (
    input: RecoverSavedAgentRosterInput
  ) => Promise<SavedAgentRosterRecoveryResult>
  bindSavedAgent: (input: BindSavedAgentInput) => Promise<PublicSessionSnapshot>
  listGrokAgentCatalog: (input: ListGrokAgentCatalogInput) => Promise<PublicGrokAgentCatalog>
  selectProject: (input: SelectProjectInput) => Promise<void>
  selectSession: (input: SelectSessionInput) => Promise<void>
  removeProject: (input: RemoveProjectInput) => Promise<void>
  moveProject: (input: MoveProjectInput) => Promise<void>
  inspectDashboardGit: () => Promise<DashboardProjectStatus>
  listProjectOpenTargets: () => Promise<ProjectOpenTargetStatus[]>
  openProject: (input: OpenProjectInput) => Promise<ProjectOpenResult>
  closeSession: (input: CloseSessionInput) => Promise<void>
  duplicateSession: (input: DuplicateSessionInput) => Promise<PublicSessionSnapshot>
  forkSession: (input: ForkSessionInput) => Promise<PublicSessionSnapshot>
  setProjectPinned: (input: SetProjectPinnedInput) => Promise<void>
  setSessionPinned: (input: SetSessionPinnedInput) => Promise<void>
  setSessionSettled: (input: SetSessionSettledInput) => Promise<void>
  setSessionUnread: (input: SetSessionUnreadInput) => Promise<void>
  listSessionHistory: () => Promise<PublicSessionHistoryRecord[]>
  searchSessionHistory: (input: SearchSessionHistoryInput) => Promise<PublicSessionHistoryRecord[]>
  openSessionHistory: (input: OpenSessionHistoryInput) => Promise<PublicSessionSnapshot>
  deleteSessionHistory: (input: DeleteSessionHistoryInput) => Promise<SessionHistoryDeleteResult>
  sendPrompt: (input: SendPromptInput) => Promise<void>
  cancelTurn: (input: CancelTurnInput) => Promise<void>
  retrySession: (input: RetrySessionInput) => Promise<void>
  answerPermission: (input: AnswerPermissionInput) => Promise<void>
  answerInteraction: (input: AnswerInteractionInput) => Promise<void>
  updateSession: (input: UpdateSessionInput) => Promise<void>
  updateSettings: (input: UpdateSettingsInput) => Promise<void>
  listMemory: () => Promise<PublicMemoryFileSummary[]>
  readMemory: (input: ReadMemoryInput) => Promise<PublicMemoryFileContents>
  rememberMemory: (input: RememberMemoryInput) => Promise<void>
  deleteMemory: (input: DeleteMemoryInput) => Promise<MemoryDeleteResult>
  listMcp: () => Promise<McpListResult>
  addMcp: (input: AddMcpInput) => Promise<McpMutationResult>
  removeMcp: (input: RemoveMcpInput) => Promise<McpMutationResult>
  enableMcp: (input: EnableMcpInput) => Promise<McpMutationResult>
  disableMcp: (input: DisableMcpInput) => Promise<McpMutationResult>
  doctorMcp: (input: DoctorMcpInput) => Promise<McpDoctorResult>
  checkDoctor: () => Promise<GrokDoctorReport>
  checkAccount: () => Promise<GrokAccountReport>
  checkUpdates: () => Promise<UpdateOverview>
  installAppUpdate: () => Promise<AppUpdateInstallResult>
  installCliUpdate: () => Promise<CliUpdateInstallResult>
  openAppRelease: () => Promise<void>
  previewSwiftImport: () => Promise<SwiftImportPreview | null>
  commitSwiftImport: (input: SwiftImportTokenInput) => Promise<SwiftImportCommitResult>
  cancelSwiftImport: (input: SwiftImportTokenInput) => Promise<void>
  onStateChanged: (listener: (snapshot: AppSnapshot) => void) => () => void
  onOpenSettings: (listener: () => void) => () => void
}
