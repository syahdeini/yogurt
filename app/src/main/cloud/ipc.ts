import { ipcMain, safeStorage, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { loadSettings, updateSettings } from '../settings'
import { CloudAuthError } from './auth'
import { createCloudRuntime, type CloudRuntime } from './runtime'
import { KeychainUnavailableError, type TokenSeal } from './tokens'
import type { AudioExt } from '../audio'
import type { Store } from '../store'

export function safeStorageSeal(): TokenSeal {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => Buffer.from(safeStorage.encryptString(plain)),
    decrypt: (sealed) => safeStorage.decryptString(sealed),
  }
}

export type CloudStatus = {
  enabled: boolean
  configured: boolean
  forced: 'on' | 'off' | null
  account: { username: string; name: string } | null
  error: 'not-configured' | 'cancelled' | 'keychain' | 'failed' | null
}

function errorCode(error: unknown): CloudStatus['error'] {
  if (error instanceof KeychainUnavailableError) return 'keychain'
  if (error instanceof CloudAuthError) return error.code === 'not-signed-in' ? 'failed' : error.code
  return 'failed'
}

export function hookCloud(deps: {
  file: string
  userData: string
  meetingDir: (id: string) => string
  exts: readonly AudioExt[]
  store: Pick<Store, 'meeting' | 'segments' | 'addSegments' | 'updateMeeting' | 'notes'>
  sendSegments: (id: string) => void
  openBrowser: (url: string) => Promise<void>
  windows?: () => BrowserWindow[]
}): CloudRuntime {
  const runtime = createCloudRuntime({
    settings: () => loadSettings(deps.file),
    cacheFile: join(deps.userData, 'entra-cache.bin'),
    jobsFile: join(deps.userData, 'cloud-jobs.json'),
    seal: safeStorageSeal(),
    meetingDir: deps.meetingDir,
    exts: deps.exts,
    store: deps.store,
    sendSegments: deps.sendSegments,
    openBrowser: deps.openBrowser,
  })
  const publish = (status: CloudStatus) => {
    for (const window of deps.windows?.() ?? []) if (!window.isDestroyed()) window.webContents.send('cloud:status', status)
  }
  const status = async (error: CloudStatus['error'] = null): Promise<CloudStatus> => {
    const account = await runtime.account()
    return {
      enabled: runtime.enabled(), configured: runtime.configured(), forced: runtime.forced(), error,
      account: account ? { username: account.username, name: account.name ?? '' } : null,
    }
  }
  ipcMain.handle('cloud:status', () => status())
  ipcMain.handle('cloud:sign-in', async () => {
    try {
      await runtime.signIn()
      const next = await status()
      publish(next)
      return next
    } catch (error) {
      console.error('cloud sign-in failed', error)
      const next = await status(errorCode(error))
      publish(next)
      return next
    }
  })
  ipcMain.handle('cloud:sign-out', async () => {
    await runtime.signOut()
    const next = await status()
    publish(next)
    return next
  })
  ipcMain.handle('cloud:enabled', async (_e, on: unknown) => {
    if (runtime.forced() || typeof on !== 'boolean') return status()
    updateSettings(deps.file, { cloudMode: on ? true : undefined })
    const next = await status()
    publish(next)
    return next
  })
  return runtime
}
