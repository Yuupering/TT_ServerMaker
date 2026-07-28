import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'
import { APP_TITLE } from '@shared/meta'
import { bindWindow } from './events'
import { registerIpc } from './ipc'
import { serverManager } from './server'
import { netManager } from './network'
import { startAutoBackup, stopAutoBackup } from './backup'
import { killAllChildren } from './util/proc'
import { getInstance } from './store'

let mainWindow: BrowserWindow | null = null
let quitting = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#14161a',
    title: APP_TITLE,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 앱 안에서 외부 링크가 열리지 않도록 기본 브라우저로 넘긴다
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  /*
   * 이 창은 우리 화면만 띄운다.
   * 어떤 경위로든 바깥 주소로 넘어가려는 시도는 막고 기본 브라우저로 넘긴다.
   * (그대로 두면 그 페이지가 preload에 노출된 API를 그대로 쓸 수 있게 된다)
   */
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const here = mainWindow?.webContents.getURL() ?? ''
    if (url === here) return
    event.preventDefault()
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
  })

  // 새 창(webview, window.open)은 애초에 만들지 않는다
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  bindWindow(mainWindow)

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('close', (event) => {
    if (quitting) return

    const status = serverManager.getStatus()
    const running = status.state === 'running' || status.state === 'starting'
    if (!running || !mainWindow) return

    event.preventDefault()

    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['서버 끄고 종료', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: '서버가 실행 중입니다',
      message: '서버가 아직 켜져 있습니다.',
      detail: '지금 종료하면 접속 중인 사람들이 모두 튕깁니다. 월드는 저장한 뒤 종료합니다.'
    })

    if (choice === 0) {
      quitting = true
      void shutdown().then(() => app.quit())
    }
  })
}

async function shutdown(): Promise<void> {
  stopAutoBackup()
  await serverManager.shutdown().catch(() => undefined)
  // 설치나 빌드가 돌고 있었다면 그 프로세스도 같이 정리한다
  await killAllChildren().catch(() => undefined)
  await netManager.shutdown().catch(() => undefined)
}

// 서버가 두 번 켜지는 사고를 막는다
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    registerIpc(() => mainWindow)
    createWindow()
    trackRunningInstance()

    await startAutoBackup(() => cachedRunningInstance)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

/** 자동 백업이 매번 디스크를 읽지 않도록 실행 중인 인스턴스를 캐시해 둔다 */
let cachedRunningInstance: Awaited<ReturnType<typeof getInstance>> = null

function trackRunningInstance(): void {
  setInterval(() => {
    const status = serverManager.getStatus()
    if (!status.instanceId || status.state !== 'running') {
      cachedRunningInstance = null
      return
    }
    if (cachedRunningInstance?.id === status.instanceId) return
    void getInstance(status.instanceId).then((i) => {
      cachedRunningInstance = i
    })
  }, 5000)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    quitting = true
    void shutdown().then(() => app.quit())
  }
})

app.on('before-quit', () => {
  quitting = true
})
