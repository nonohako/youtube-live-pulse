'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const sourcePath = path.join(__dirname, '..', 'assets', 'pulse.svg');
  const outputPath = path.join(__dirname, '..', 'assets', 'pulse.png');
  const svg = fs.readFileSync(sourcePath, 'utf8')
    .replace('<svg ', '<svg width="512" height="512" style="display:block" ');
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    show: false,
    frame: false,
    backgroundColor: '#11131a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  const markup = `<!doctype html><style>*{box-sizing:border-box}html,body{margin:0;width:512px;height:512px;overflow:hidden;background:transparent}</style>${svg}`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(markup)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const icon = await window.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const png = icon.toPNG();
  if (!png.length) throw new Error('아이콘 렌더링 결과가 비어 있습니다.');
  fs.writeFileSync(outputPath, png);
  process.stdout.write(`ICON=${outputPath}\n`);
  window.destroy();
  app.quit();
});
