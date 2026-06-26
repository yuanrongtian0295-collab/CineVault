import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  accessSync,
  appendFileSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, protocol, shell } from 'electron'
import type { MessageBoxOptions, OpenDialogOptions, SaveDialogOptions } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import {
  createDatabase,
  cancelPendingDataRootOverride,
  commitPendingDataRootOnStartup,
  getBackupsPath,
  getDatabasePath,
  getDatabasePathOverride,
  getDataRootOverride,
  getDefaultDataRoot,
  getDefaultDatabasePath,
  getEffectiveDataRoot,
  getGeneratedPath,
  getPendingDataRootOverride,
  getPreviousDataRoot,
  readStoragePreferences,
  setPendingDataRootOverride,
  getStoragePreferencesPath,
  getThumbnailsPath,
  setDataRootOverride,
  setDatabasePathOverride,
  writeStoragePreferences
} from './ipc/database'
import { createProjectRepository, registerProjectIpc } from './ipc/projects'
import { createAssetRepository, registerAssetFileProtocol, registerAssetIpc } from './ipc/assets'
import { createCharacterRepository, registerCharacterIpc } from './ipc/characters'
import { createSceneRepository, registerSceneIpc } from './ipc/scenes'
import { createShotRepository, registerShotIpc } from './ipc/shots'
import { createRelationRepository, registerRelationIpc } from './ipc/relations'
import { createDashboardRepository, registerDashboardIpc } from './ipc/dashboard'
import { createStoryboardRepository, registerStoryboardIpc } from './ipc/storyboard'
import { createStoryboardImportRepository, registerStoryboardImportIpc } from './ipc/storyboardImport'
import { createScriptRepository, registerScriptIpc } from './ipc/scripts'
import { createRelationshipGraphRepository, registerRelationshipGraphIpc } from './ipc/relationshipGraph'
import { createVersionRepository, registerVersionIpc } from './ipc/versions'
import { createProjectToolsRepository, registerProjectToolsIpc } from './ipc/projectTools'
import { createAIRepository, registerAIIpc } from './ipc/ai'
import { createAITaskRepository, registerAITaskIpc } from './ipc/aiTasks'
import { createBillingRepository, registerBillingIpc } from './ipc/billing'
import { createGenerationRepository, registerGenerationIpc } from './ipc/generation'
import { createReferencePublishService } from './ipc/referencePublishService'
import { createCanvasRepository, registerCanvasIpc } from './ipc/canvas'
import type { AppDatabase } from './ipc/database'
import type {
  DatabasePathMigrationResult,
  DataRootMigrationMode,
  DataRootMigrationPreview,
  DataRootMigrationResult,
  StorageConfig,
  UpdateConfig,
  UpdateConfigInput,
  UpdateCheckResult,
  UpdateDismissMode,
  UpdateManifest
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
const appIconPath = join(app.getAppPath(), 'resources', 'icon.png')

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cinevault-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  }
])

function log(message: string): void {
  try {
    const userData = app.getPath('userData')
    mkdirSync(userData, { recursive: true })
    appendFileSync(join(userData, 'cinevault-main.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    // Logging must never block app startup.
  }
}

function normalizePathForCompare(filePath: string): string {
  return resolve(filePath).replace(/\\/g, '/').toLowerCase()
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function ensureDatabaseTargetPath(targetPath: string): string {
  const resolvedPath = resolve(targetPath)
  const targetDir = dirname(resolvedPath)
  const normalizedDir = normalizePathForCompare(targetDir)
  const forbiddenDirs = [
    normalizePathForCompare(app.getPath('home')),
    'c:/',
    'c:/windows',
    'c:/program files',
    'c:/program files (x86)'
  ]

  if (!resolvedPath.trim()) throw new Error('请选择有效的数据库文件位置')
  if (forbiddenDirs.includes(normalizedDir)) {
    throw new Error('不能把数据库直接放在系统目录或用户根目录，请选择一个专用文件夹')
  }

  mkdirSync(targetDir, { recursive: true })
  return resolvedPath
}

function fileDialogFilters(filePath: string): SaveDialogOptions['filters'] {
  const extension = extname(filePath).replace(/^\./, '').toLowerCase()
  const imageExtensions = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'tif', 'tiff']
  const videoExtensions = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']
  if (extension && imageExtensions.includes(extension)) return [{ name: '图片文件', extensions: [extension] }]
  if (extension && videoExtensions.includes(extension)) return [{ name: '视频文件', extensions: [extension] }]
  return extension ? [{ name: '当前文件', extensions: [extension] }] : [{ name: '所有文件', extensions: ['*'] }]
}

function ensureReadableFile(filePath: string): string {
  const resolvedPath = resolve(filePath)
  if (!existsSync(resolvedPath)) throw new Error('文件不存在，无法执行操作')
  const fileStat = statSync(resolvedPath)
  if (!fileStat.isFile()) throw new Error('请选择有效文件')
  return resolvedPath
}

function buildStorageConfig(activeDatabasePath: string, thumbnailsPath: string, generatedPath: string): StorageConfig {
  const effectiveDatabasePath = getDatabasePath()
  const defaultDatabasePath = getDefaultDatabasePath()
  const databasePathOverride = getDatabasePathOverride()
  const defaultDataRoot = getDefaultDataRoot()
  const activeDataRoot = dirname(activeDatabasePath)
  const effectiveDataRoot = getEffectiveDataRoot()
  const dataRootOverride = getDataRootOverride()
  const pendingDataRootOverride = getPendingDataRootOverride()
  const previousDataRoot = getPreviousDataRoot()
  const preferences = readStoragePreferences()
  const restartRequired = normalizePathForCompare(activeDatabasePath) !== normalizePathForCompare(effectiveDatabasePath)

  return {
    defaultDataRoot,
    currentDataRoot: activeDataRoot,
    effectiveDataRoot,
    pendingDataRootOverride,
    dataRootOverride,
    previousDataRoot,
    legacyDatabasePathOverride: preferences.databasePathOverrideLegacy ?? databasePathOverride,
    legacyDatabasePathMode: Boolean(databasePathOverride) && !dataRootOverride && !pendingDataRootOverride,
    defaultDatabasePath,
    currentDatabasePath: activeDatabasePath,
    effectiveDatabasePath,
    databasePathOverride,
    isCustomDatabasePath: Boolean(databasePathOverride || dataRootOverride || pendingDataRootOverride),
    restartRequired,
    thumbnailsPath,
    generatedPath,
    backupRoot: getBackupsPath(),
    configPath: getStoragePreferencesPath()
  }
}

function backupDatabase(db: AppDatabase, backupType = 'storage-migration'): string {
  const backupRoot = getBackupsPath()
  mkdirSync(backupRoot, { recursive: true })
  const backupPath = join(backupRoot, `CineVault-${backupType}-${timestampForFileName()}.sqlite`)
  db.exec('pragma wal_checkpoint(full)')
  db.exec(`vacuum into ${sqlStringLiteral(backupPath)}`)
  return backupPath
}

function folderSize(root: string): { fileCount: number; totalBytes: number } {
  if (!existsSync(root)) return { fileCount: 0, totalBytes: 0 }
  let fileCount = 0
  let totalBytes = 0
  const entries = readdirSync(root, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = folderSize(entryPath)
      fileCount += nested.fileCount
      totalBytes += nested.totalBytes
    } else if (entry.isFile()) {
      fileCount += 1
      totalBytes += statSync(entryPath).size
    }
  }

  return { fileCount, totalBytes }
}

function copyDirectoryContents(sourceRoot: string, targetRoot: string, skipNames = new Set<string>()): { copiedFiles: number; copiedBytes: number; skippedFiles: number } {
  if (!existsSync(sourceRoot)) return { copiedFiles: 0, copiedBytes: 0, skippedFiles: 0 }
  mkdirSync(targetRoot, { recursive: true })
  let copiedFiles = 0
  let copiedBytes = 0
  let skippedFiles = 0

  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) {
      skippedFiles += 1
      continue
    }

    const sourcePath = join(sourceRoot, entry.name)
    const targetPath = join(targetRoot, entry.name)
    if (entry.isDirectory()) {
      const nested = copyDirectoryContents(sourcePath, targetPath, skipNames)
      copiedFiles += nested.copiedFiles
      copiedBytes += nested.copiedBytes
      skippedFiles += nested.skippedFiles
    } else if (entry.isFile()) {
      mkdirSync(dirname(targetPath), { recursive: true })
      copyFileSync(sourcePath, targetPath)
      copiedFiles += 1
      copiedBytes += statSync(sourcePath).size
    }
  }

  return { copiedFiles, copiedBytes, skippedFiles }
}

function assertWritableDirectory(targetRoot: string): void {
  mkdirSync(targetRoot, { recursive: true })
  accessSync(targetRoot, constants.W_OK)
}

function findExistingParent(targetRoot: string): string {
  let current = resolve(targetRoot)
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

function isChildOrSamePath(parent: string, candidate: string): boolean {
  const normalizedParent = normalizePathForCompare(parent)
  const normalizedCandidate = normalizePathForCompare(candidate)
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`)
}

function getTargetRootStatus(targetRoot: string): {
  targetExists: boolean
  targetIsEmpty: boolean
  targetHasCineVaultData: boolean
  targetHasRegularFiles: boolean
} {
  const targetExists = existsSync(targetRoot)
  if (!targetExists) {
    return {
      targetExists,
      targetIsEmpty: true,
      targetHasCineVaultData: false,
      targetHasRegularFiles: false
    }
  }

  if (!statSync(targetRoot).isDirectory()) {
    return {
      targetExists,
      targetIsEmpty: false,
      targetHasCineVaultData: false,
      targetHasRegularFiles: true
    }
  }

  const entries = readdirSync(targetRoot)
  const targetIsEmpty = entries.length === 0
  const targetHasCineVaultData = existsSync(join(targetRoot, 'cinevault.sqlite')) || existsSync(join(targetRoot, 'migration-manifest.json'))
  return {
    targetExists,
    targetIsEmpty,
    targetHasCineVaultData,
    targetHasRegularFiles: !targetIsEmpty && !targetHasCineVaultData
  }
}

function getDatabaseIntegrity(db: AppDatabase): 'ok' | 'failed' | 'missing' {
  try {
    const row = db.prepare('pragma integrity_check').get() as Record<string, unknown> | undefined
    const value = row ? String(Object.values(row)[0]) : ''
    return value === 'ok' ? 'ok' : 'failed'
  } catch {
    return 'failed'
  }
}

function clearManagedDataRootEntries(targetRoot: string): void {
  const managedEntries = [
    'cinevault.sqlite',
    'cinevault.sqlite-wal',
    'cinevault.sqlite-shm',
    'migration-manifest.json',
    'thumbnails',
    'generated',
    'backups'
  ]

  for (const entryName of managedEntries) {
    const entryPath = join(targetRoot, entryName)
    if (existsSync(entryPath)) {
      rmSync(entryPath, { recursive: true, force: true })
    }
  }
}

function analyzeDataRootMigration(
  db: AppDatabase,
  activeDatabasePath: string,
  targetRootInput: string
): DataRootMigrationPreview {
  const sourceRoot = dirname(activeDatabasePath)
  const targetRoot = resolve(targetRootInput)
  const sourceDatabasePath = activeDatabasePath
  const targetDatabasePath = join(targetRoot, 'cinevault.sqlite')
  const errors: string[] = []
  const warnings: string[] = []

  if (!targetRoot.trim()) errors.push('请选择有效的数据目录')
  if (isChildOrSamePath(sourceRoot, targetRoot) || isChildOrSamePath(targetRoot, sourceRoot)) {
    errors.push('目标目录不能是当前数据目录、父目录或子目录')
  }

  const normalizedTarget = normalizePathForCompare(targetRoot)
  const forbiddenDirs = [
    normalizePathForCompare(app.getPath('home')),
    'c:/',
    'c:/windows',
    'c:/program files',
    'c:/program files (x86)'
  ]
  if (forbiddenDirs.includes(normalizedTarget)) {
    errors.push('不能把数据目录直接放在系统目录或用户根目录')
  }

  const targetStatus = getTargetRootStatus(targetRoot)
  if (targetStatus.targetHasRegularFiles) {
    errors.push('目标目录已有普通文件，请选择空目录或已有 CineVault 数据目录')
  }

  try {
    if (existsSync(targetRoot)) accessSync(targetRoot, constants.W_OK)
    else accessSync(findExistingParent(targetRoot), constants.W_OK)
  } catch {
    errors.push('目标目录不可写')
  }

  const sourceSize = folderSize(sourceRoot)
  const databaseIntegrity = existsSync(sourceDatabasePath) ? getDatabaseIntegrity(db) : 'missing'
  if (databaseIntegrity !== 'ok') warnings.push('当前数据库完整性检查未通过，迁移前建议先备份并排查')

  return {
    sourceRoot,
    targetRoot,
    sourceDatabasePath,
    targetDatabasePath,
    ...targetStatus,
    fileCount: sourceSize.fileCount,
    totalBytes: sourceSize.totalBytes,
    databaseIntegrity,
    restartRequired: true,
    canCopyCurrentData: errors.length === 0 && (targetStatus.targetIsEmpty || !targetStatus.targetExists),
    canUseExistingData: errors.length === 0 && targetStatus.targetHasCineVaultData,
    canOverwriteExistingData: errors.length === 0 && !targetStatus.targetHasRegularFiles,
    warnings,
    errors
  }
}

function migrateDataRoot(
  db: AppDatabase,
  activeDatabasePath: string,
  targetRootInput: string,
  mode: DataRootMigrationMode
): DataRootMigrationResult {
  const preview = analyzeDataRootMigration(db, activeDatabasePath, targetRootInput)
  const targetRoot = preview.targetRoot
  if (preview.errors.length > 0) throw new Error(preview.errors.join('；'))
  if (mode === 'copy-current-data' && !preview.canCopyCurrentData) throw new Error('目标目录不适合直接迁移当前数据')
  if (mode === 'use-existing-data' && !preview.canUseExistingData) throw new Error('目标目录不是有效的 CineVault 数据目录')
  if (mode === 'overwrite-existing-data' && !preview.canOverwriteExistingData) throw new Error('目标目录不能被覆盖为当前数据副本')

  assertWritableDirectory(targetRoot)
  let copiedFiles = 0
  let copiedBytes = 0
  let skippedFiles = 0
  let backupPath: string | null = null

  if (mode !== 'use-existing-data') {
    backupPath = backupDatabase(db, 'data-root-migration')
    if (mode === 'overwrite-existing-data') {
      clearManagedDataRootEntries(targetRoot)
    }
    const copied = copyDirectoryContents(preview.sourceRoot, targetRoot, new Set(['cinevault.sqlite', 'cinevault.sqlite-wal', 'cinevault.sqlite-shm']))
    copiedFiles = copied.copiedFiles
    copiedBytes = copied.copiedBytes
    skippedFiles = copied.skippedFiles
    writeDatabaseCopy(db, preview.targetDatabasePath)
    copiedFiles += 1
    copiedBytes += existsSync(preview.targetDatabasePath) ? statSync(preview.targetDatabasePath).size : 0
  }

  const manifestPath = join(targetRoot, 'migration-manifest.json')
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        migratedAt: new Date().toISOString(),
        sourceRoot: preview.sourceRoot,
        targetRoot,
        mode,
        copiedFiles,
        copiedBytes,
        skippedFiles,
        backupPath
      },
      null,
      2
    ),
    'utf-8'
  )

  setPendingDataRootOverride(targetRoot, preview.sourceRoot)

  return {
    sourceRoot: preview.sourceRoot,
    targetRoot,
    mode,
    copiedFiles,
    copiedBytes,
    skippedFiles,
    backupPath,
    manifestPath,
    restartRequired: true,
    message: '完整数据目录迁移已准备完成，重启应用后生效',
    warnings: preview.warnings
  }
}

function writeDatabaseCopy(db: AppDatabase, targetPath: string): void {
  const tempPath = `${targetPath}.tmp-${Date.now()}`
  try {
    db.exec('pragma wal_checkpoint(full)')
    db.exec(`vacuum into ${sqlStringLiteral(tempPath)}`)
    if (existsSync(targetPath)) unlinkSync(targetPath)
    renameSync(tempPath, targetPath)
  } catch (error) {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath)
      } catch {
        // Ignore cleanup failures so the original error is preserved.
      }
    }
    throw error
  }
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function normalizeManifestUrl(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString()
  } catch {
    return null
  }
}

const DEFAULT_UPDATE_MANIFEST_URL = 'https://yuanrongtian0295-collab.github.io/CineVault/update-manifest.json'

function getUpdateConfig(): UpdateConfig {
  const preferences = readStoragePreferences()
  const envManifestUrl = normalizeManifestUrl(process.env.CINEVAULT_UPDATE_MANIFEST_URL)
  return {
    manifestUrl:
      envManifestUrl ??
      normalizeManifestUrl(preferences.updateManifestUrl) ??
      DEFAULT_UPDATE_MANIFEST_URL,
    ignoredVersion: preferences.updateIgnoredVersion ?? null,
    lastCheckedAt: preferences.updateLastCheckedAt ?? null
  }
}

function updateUpdateConfig(input: UpdateConfigInput): UpdateConfig {
  const preferences = readStoragePreferences()
  const nextManifestUrl =
    Object.prototype.hasOwnProperty.call(input, 'manifestUrl')
      ? normalizeManifestUrl(input.manifestUrl)
      : normalizeManifestUrl(preferences.updateManifestUrl)

  writeStoragePreferences({
    ...preferences,
    updateManifestUrl: nextManifestUrl,
    updateIgnoredVersion:
      Object.prototype.hasOwnProperty.call(input, 'ignoredVersion')
        ? input.ignoredVersion ?? null
        : preferences.updateIgnoredVersion ?? null,
    updateLastCheckedAt:
      Object.prototype.hasOwnProperty.call(input, 'lastCheckedAt')
        ? input.lastCheckedAt ?? null
        : preferences.updateLastCheckedAt ?? null
  })
  return getUpdateConfig()
}

function parseUpdateManifest(raw: string): UpdateManifest {
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, '').trimStart()) as Partial<UpdateManifest>
  if (!parsed.version || !parsed.releaseDate || !Array.isArray(parsed.notes)) {
    throw new Error('更新清单格式不完整')
  }
  return {
    version: parsed.version,
    releaseDate: parsed.releaseDate,
    downloadUrl: parsed.downloadUrl ?? '',
    downloadPageUrl: parsed.downloadPageUrl ?? undefined,
    installerUrl: parsed.installerUrl ?? undefined,
    fileSize: parsed.fileSize ?? undefined,
    sha256: parsed.sha256 ?? undefined,
    notes: parsed.notes
  }
}

async function readRemoteUpdateManifest(manifestUrl: string): Promise<UpdateManifest> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(manifestUrl, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return parseUpdateManifest(await response.text())
  } finally {
    clearTimeout(timer)
  }
}

function readLocalUpdateManifest(): UpdateManifest {
  const manifestPath = join(app.getAppPath(), 'resources', 'update-manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`未找到更新清单：${manifestPath}`)
  return parseUpdateManifest(readFileSync(manifestPath, 'utf-8'))
}

async function readUpdateManifest(): Promise<{
  manifest: UpdateManifest
  source: 'remote' | 'local'
  manifestUrl: string | null
  remoteError: string | null
}> {
  const manifestUrl = getUpdateConfig().manifestUrl
  if (manifestUrl) {
    try {
      return {
        manifest: await readRemoteUpdateManifest(manifestUrl),
        source: 'remote',
        manifestUrl,
        remoteError: null
      }
    } catch (error) {
      return {
        manifest: readLocalUpdateManifest(),
        source: 'local',
        manifestUrl,
        remoteError: `远程更新清单读取失败，已回退本地清单：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  return {
    manifest: readLocalUpdateManifest(),
    source: 'local',
    manifestUrl: null,
    remoteError: null
  }
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion()
  const checkedAt = new Date().toISOString()
  try {
    const { manifest, source, manifestUrl, remoteError } = await readUpdateManifest()
    updateUpdateConfig({ lastCheckedAt: checkedAt })
    const ignored = getUpdateConfig().ignoredVersion === manifest.version
    const isNewer = compareVersions(manifest.version, currentVersion) > 0
    return {
      currentVersion,
      latestVersion: manifest.version,
      available: isNewer && !ignored,
      manifest,
      error: remoteError,
      source,
      manifestUrl,
      checkedAt,
      ignored
    }
  } catch (error) {
    updateUpdateConfig({ lastCheckedAt: checkedAt })
    return {
      currentVersion,
      latestVersion: null,
      available: false,
      manifest: null,
      error: error instanceof Error ? error.message : String(error),
      source: 'local',
      manifestUrl: getUpdateConfig().manifestUrl,
      checkedAt,
      ignored: false
    }
  }
}

function createWindow(): void {
  log('createWindow:start')
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#F7F4EE',
    title: 'CineVault / 影匣',
    icon: appIconPath,
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true
    }
  })

  const showMainWindow = (): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return
    log('window:show')
    mainWindow?.show()
    mainWindow?.focus()
  }

  mainWindow.on('ready-to-show', showMainWindow)
  mainWindow.webContents.on('did-finish-load', showMainWindow)
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    log(`window:did-fail-load code=${code} description=${description} url=${url}`)
    showMainWindow()
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`window:render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
  })
  mainWindow.on('closed', () => {
    log('window:closed')
    mainWindow = null
  })
  setTimeout(showMainWindow, 3000)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    log(`window:loadURL ${process.env.ELECTRON_RENDERER_URL}`)
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const rendererPath = join(__dirname, '../renderer/index.html')
    log(`window:loadFile ${rendererPath}`)
    mainWindow.loadFile(rendererPath)
  }
}

app.whenReady().then(() => {
  log('app:ready')
  Menu.setApplicationMenu(null)
  electronApp.setAppUserModelId('com.cinevault.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  log('database:create:start')
  const startupPendingDataRoot = getPendingDataRootOverride()
  let activeDatabasePath = getDatabasePath()
  let db: AppDatabase
  try {
    if (startupPendingDataRoot && !existsSync(activeDatabasePath)) {
      cancelPendingDataRootOverride()
      activeDatabasePath = getDatabasePath()
    }
    db = createDatabase(activeDatabasePath)
    if (startupPendingDataRoot && normalizePathForCompare(activeDatabasePath) === normalizePathForCompare(join(startupPendingDataRoot, 'cinevault.sqlite'))) {
      commitPendingDataRootOnStartup()
    }
  } catch (error) {
    if (!startupPendingDataRoot) throw error
    log(`database:pendingDataRoot:error ${error instanceof Error ? error.message : String(error)}`)
    cancelPendingDataRootOverride()
    activeDatabasePath = getDatabasePath()
    db = createDatabase(activeDatabasePath)
  }
  log('database:create:done')
  const thumbnailsPath = getThumbnailsPath()
  const generatedPath = getGeneratedPath()
  const assetRepository = createAssetRepository(db, thumbnailsPath)
  const characterRepository = createCharacterRepository(db, assetRepository)
  const sceneRepository = createSceneRepository(db, assetRepository)
  const shotRepository = createShotRepository(db, assetRepository)
  const relationRepository = createRelationRepository(
    db,
    assetRepository,
    characterRepository,
    sceneRepository,
    shotRepository
  )
  const dashboardRepository = createDashboardRepository(db, assetRepository)
  const storyboardRepository = createStoryboardRepository(
    db,
    characterRepository,
    sceneRepository,
    shotRepository
  )
  const storyboardImportRepository = createStoryboardImportRepository(
    db,
    characterRepository,
    sceneRepository,
    shotRepository
  )
  const scriptRepository = createScriptRepository(db)
  const relationshipGraphRepository = createRelationshipGraphRepository(db)
  const versionRepository = createVersionRepository(db, assetRepository)
  const aiTaskRepository = createAITaskRepository(db)
  const billingRepository = createBillingRepository(db)
  const aiRepository = createAIRepository(db, billingRepository)
  const referencePublishService = createReferencePublishService({
    tempRoot: join(dirname(activeDatabasePath), 'reference-publish')
  })
  const generationRepository = createGenerationRepository(db, assetRepository, generatedPath, aiTaskRepository, referencePublishService, billingRepository)
  const canvasRepository = createCanvasRepository(db, generationRepository)
  const projectToolsRepository = createProjectToolsRepository(db, assetRepository, {
    databasePath: activeDatabasePath,
    backupRoot: join(dirname(activeDatabasePath), 'backups')
  })
  registerAssetFileProtocol(db, thumbnailsPath)
  registerProjectIpc(createProjectRepository(db, assetRepository))
  registerAssetIpc(assetRepository)
  registerCharacterIpc(characterRepository)
  registerSceneIpc(sceneRepository)
  registerShotIpc(shotRepository)
  registerRelationIpc(relationRepository)
  registerDashboardIpc(dashboardRepository)
  registerStoryboardIpc(storyboardRepository)
  registerStoryboardImportIpc(storyboardImportRepository)
  registerScriptIpc(scriptRepository)
  registerRelationshipGraphIpc(relationshipGraphRepository)
  registerVersionIpc(versionRepository)
  registerProjectToolsIpc(projectToolsRepository)
  registerAITaskIpc(aiTaskRepository)
  registerBillingIpc(billingRepository)
  registerAIIpc(aiRepository, aiTaskRepository, billingRepository)
  registerGenerationIpc(generationRepository)
  registerCanvasIpc(canvasRepository)

  ipcMain.handle('files:exportLocalFile', async (_event, sourcePath: string, suggestedName?: string | null): Promise<string | null> => {
    const resolvedSource = ensureReadableFile(sourcePath)
    const defaultPath = suggestedName?.trim() ? suggestedName.trim() : basename(resolvedSource)
    const options: SaveDialogOptions = {
      title: '导出文件',
      defaultPath,
      filters: fileDialogFilters(resolvedSource)
    }
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    copyFileSync(resolvedSource, result.filePath)
    return result.filePath
  })

  ipcMain.handle('files:copyImageToClipboard', (_event, sourcePath: string): boolean => {
    const resolvedSource = ensureReadableFile(sourcePath)
    const image = nativeImage.createFromPath(resolvedSource)
    if (image.isEmpty()) throw new Error('当前文件不是可复制的图片')
    clipboard.writeImage(image)
    return true
  })

  log('ipc:registered projects assets characters scenes shots relations dashboard storyboard imports scripts relationshipGraph versions tools aiTasks ai generation canvas')

  ipcMain.handle('app:ipcHealth', () => ({
    scripts: true,
    relationshipGraph: true,
    versions: true,
    tools: true,
    ai: true,
    aiTasks: true,
    generation: true,
    referencePublishing: true,
    canvas: true
  }))

  ipcMain.handle('settings:getPaths', () => ({
    databasePath: activeDatabasePath,
    thumbnailsPath,
    generatedPath
  }))

  ipcMain.handle('settings:getStorageConfig', () =>
    buildStorageConfig(activeDatabasePath, thumbnailsPath, generatedPath)
  )

  ipcMain.handle('settings:chooseDataRoot', async () => {
    const options: OpenDialogOptions = {
      title: '选择 CineVault 数据目录',
      properties: ['openDirectory', 'createDirectory']
    }
    const window = mainWindow ?? BrowserWindow.getFocusedWindow()
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('settings:analyzeDataRootMigration', (_event, targetRoot: string): DataRootMigrationPreview =>
    analyzeDataRootMigration(db, activeDatabasePath, targetRoot)
  )

  ipcMain.handle(
    'settings:migrateDataRoot',
    (_event, targetRoot: string, mode: DataRootMigrationMode = 'copy-current-data'): DataRootMigrationResult =>
      migrateDataRoot(db, activeDatabasePath, targetRoot, mode)
  )

  ipcMain.handle('settings:resetDataRoot', (): StorageConfig => {
    setDataRootOverride(null)
    return buildStorageConfig(activeDatabasePath, thumbnailsPath, generatedPath)
  })

  ipcMain.handle('settings:openDataRoot', async () => {
    return shell.openPath(dirname(activeDatabasePath))
  })

  ipcMain.handle('settings:cancelPendingDataRootMigration', (): StorageConfig => {
    cancelPendingDataRootOverride()
    return buildStorageConfig(activeDatabasePath, thumbnailsPath, generatedPath)
  })

  ipcMain.handle('settings:chooseDatabasePath', async () => {
    const options: SaveDialogOptions = {
      title: '选择 CineVault 数据库位置',
      defaultPath: join(dirname(getDatabasePath()), 'cinevault.sqlite'),
      filters: [
        { name: 'SQLite 数据库', extensions: ['sqlite', 'db'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    }
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
    return result.canceled ? null : result.filePath
  })

  ipcMain.handle('settings:migrateDatabasePath', async (_event, targetPath: string): Promise<DatabasePathMigrationResult> => {
    const nextDatabasePath = ensureDatabaseTargetPath(targetPath)
    if (normalizePathForCompare(activeDatabasePath) === normalizePathForCompare(nextDatabasePath)) {
      return {
        currentDatabasePath: activeDatabasePath,
        nextDatabasePath,
        backupPath: null,
        copied: false,
        usedExisting: false,
        restartRequired: false,
        message: '当前已经在使用这个数据库位置'
      }
    }

    const backupPath = backupDatabase(db)
    let copied = false
    let usedExisting = false

    if (existsSync(nextDatabasePath)) {
      const options: MessageBoxOptions = {
        type: 'question',
        buttons: ['使用已有数据库', '覆盖为当前数据库副本', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: '目标数据库已存在',
        message: '目标位置已经有数据库文件，你想如何处理？',
        detail: nextDatabasePath
      }
      const choice = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options)

      if (choice.response === 2) throw new Error('已取消数据库迁移')
      if (choice.response === 0) {
        usedExisting = true
      } else {
        writeDatabaseCopy(db, nextDatabasePath)
        copied = true
      }
    } else {
      writeDatabaseCopy(db, nextDatabasePath)
      copied = true
    }

    setDatabasePathOverride(nextDatabasePath)
    return {
      currentDatabasePath: activeDatabasePath,
      nextDatabasePath,
      backupPath,
      copied,
      usedExisting,
      restartRequired: true,
      message: '数据库位置已保存，重启应用后生效'
    }
  })

  ipcMain.handle('settings:resetDatabasePath', (): StorageConfig => {
    setDatabasePathOverride(null)
    return buildStorageConfig(activeDatabasePath, thumbnailsPath, generatedPath)
  })

  ipcMain.handle('settings:openDatabaseFolder', async () => {
    return shell.openPath(dirname(activeDatabasePath))
  })

  ipcMain.handle('app:restart', () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle('updates:getConfig', () => getUpdateConfig())
  ipcMain.handle('updates:updateConfig', (_event, input: UpdateConfigInput) => updateUpdateConfig(input))
  ipcMain.handle('updates:dismiss', (_event, version: string, mode: UpdateDismissMode) => {
    if (mode === 'ignore') return updateUpdateConfig({ ignoredVersion: version })
    return getUpdateConfig()
  })
  ipcMain.handle('updates:openDownloadPage', async (_event, url: string) => {
    const normalized = normalizeManifestUrl(url)
    if (!normalized) throw new Error('下载页地址无效')
    await shell.openExternal(normalized)
  })
  ipcMain.handle('updates:check', () => checkForUpdates())

  ipcMain.handle('window:minimize', () => {
    const window = BrowserWindow.getFocusedWindow() ?? mainWindow
    window?.minimize()
  })

  ipcMain.handle('window:toggleMaximize', () => {
    const window = BrowserWindow.getFocusedWindow() ?? mainWindow
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  ipcMain.handle('window:close', () => {
    const window = BrowserWindow.getFocusedWindow() ?? mainWindow
    window?.close()
  })

  createWindow()

  setTimeout(() => {
    checkForUpdates()
      .then((result) => {
        if (result.available) mainWindow?.webContents.send('updates:available', result)
      })
      .catch((error) => {
        log(`updates:startup:error ${error instanceof Error ? error.message : String(error)}`)
      })
  }, 4500)

  setTimeout(() => {
    assetRepository.backfillMissingThumbnails().catch((error) => {
      log(`thumbnails:backfill:error ${error instanceof Error ? error.message : String(error)}`)
    })
  }, 1000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})


