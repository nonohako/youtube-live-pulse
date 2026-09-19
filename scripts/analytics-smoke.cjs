'use strict';
const {app, BrowserWindow, ipcMain} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const source = packaged ? path.join(root, 'dist/win-unpacked/resources/app.asar/src') : path.join(root, 'src');
const output = path.join(root, 'artifacts');
app.setPath('userData', path.join(root, '.smoke-user-data', 'analytics-ui'));
app.setAppUserModelId(process.execPath);
const {createDefaultData} = require(path.join(source, 'lib/defaults'));
const {ChannelMonitor} = require(path.join(source, 'lib/monitor'));
const data = createDefaultData();
const now = Date.now();
const samples = Array.from({length: 240}, (_,i) => ({at: new Date(now-(239-i)*12*3600000).toISOString(), count: 120000+i*250}));
data.channels[0].title = 'RESCENE'; data.channels[0].subscriberHistory = samples;
const videos = ['mFM2hP5LEhM','WTdyA5N4K0k','abcdefghijk','12345678901'];
data.channels[0].videoViewHistories = videos.map((id,i) => ({videoId:id,title:['첫 번째 영상 · 컴백 무대','두 번째 영상 · 비하인드','쇼츠 모음','일상 브이로그'][i],url:'https://www.youtube.com/watch?v='+id,samples:samples.map(s=>({...s,count:Math.round(s.count*(i+1)/2)}))}));
const monitor = new ChannelMonitor({store:{data}});
ipcMain.handle('state:get', () => ({...monitor.publicState(),app:{version:'1.9.0'}}));
let win;
async function js(code) { return win.webContents.executeJavaScript(code); }
async function shot(name) { win.webContents.invalidate(); await win.webContents.capturePage(); await new Promise(r=>setTimeout(r,300)); fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG()); }
app.whenReady().then(async()=>{
 try {
  fs.mkdirSync(output,{recursive:true});
  win = new BrowserWindow({width:1180,height:800,show:false,webPreferences:{backgroundThrottling:false,preload:path.join(source,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const errors=[];win.webContents.on('console-message',(_e,level,message)=>{if(level>=3&&!message.includes('ERR_'))errors.push(message)});
  await win.loadFile(path.join(source,'renderer/index.html'));
  for(let i=0;i<50;i++){if(await js("!!appState"))break;await new Promise(r=>setTimeout(r,100));}
  await js("localStorage.removeItem('live-pulse:chart-preferences');document.getElementById('views-nav').click()");
  assert.equal(await js("document.querySelectorAll('.view-card').length"),4);
  assert.equal(await js("document.getElementById('dashboard').hidden"),true);
  await js("Promise.race([Promise.all([...document.querySelectorAll('.view-card img')].map(img=>img.decode().catch(()=>{}))),new Promise(r=>setTimeout(r,5000))])");
  await shot('analytics-library.png');
  await js("document.getElementById('views-search').value='비하인드';document.getElementById('views-search').dispatchEvent(new Event('input'))");
  assert.equal(await js("document.querySelectorAll('.view-card').length"),1);
  await js("document.getElementById('views-search').value='';document.getElementById('views-search').dispatchEvent(new Event('input'));document.querySelector('.view-card-open').click()");
  assert.equal(await js("document.getElementById('video-view-dialog').open"),true);
  await js("document.querySelector('[data-video-view-range=\"90d\"]').click();const mode=document.getElementById('video-chart-mode');mode.value='daily';mode.dispatchEvent(new Event('change'))");
  assert.equal(await js("videoViewChartModel.displayMode"),'daily');
  assert.ok(await js("videoViewChartModel.points.length < 200"));
  await js("document.getElementById('video-view-close').click();document.querySelector('.view-card-open').click()");
  assert.equal(await js("videoViewChartRange"),'90d');
  await js("(()=>{const svg=document.getElementById('video-view-detail-svg'),b=svg.getBoundingClientRect();svg.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:b.left+b.width/2,clientY:b.top+100}));return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()");
  assert.equal(await js("document.getElementById('video-view-tooltip').classList.contains('hidden')"),false);
  await js("window.__hoverSvg=document.getElementById('video-view-detail-svg')");
  const delta={...monitor.publicState(),channels:monitor.publicState().channels.map(c=>({...c,subscriberHistory:undefined,videoViewHistories:undefined,historiesUnchanged:true}))};
  win.webContents.send('state:changed',delta);
  await new Promise(r=>setTimeout(r,350));
  assert.equal(await js("window.__hoverSvg===document.getElementById('video-view-detail-svg')"),true);
  assert.ok(await js("appState.channels[0].videoViewHistories.length>0"));
  await shot('analytics-video.png');
  await js("document.getElementById('video-view-close').click();document.querySelectorAll('[data-compare-video]')[0].click();document.querySelectorAll('[data-compare-video]')[1].click();document.getElementById('views-compare').click()");
  assert.equal(await js("document.querySelectorAll('.compare-svg path').length"),2);
  await js("document.querySelector('[data-compare-range=\"90d\"]').click();document.getElementById('compare-metric').value='change';document.getElementById('compare-metric').dispatchEvent(new Event('change'))");
  await js("(()=>{const svg=document.querySelector('.compare-svg'),b=svg.getBoundingClientRect();window.__hoverMoves=0;const original=moveComparisonHover;moveComparisonHover=e=>{window.__hoverMoves++;original(e)};for(let i=0;i<100;i++)svg.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:b.left+b.width/2+i/10,clientY:b.top+100}));return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))})()");
  assert.equal(await js("window.__hoverMoves"),1);
  assert.equal(await js("document.getElementById('compare-hover-tip').classList.contains('hidden')"),false);
  assert.equal(await js("document.querySelectorAll('.compare-svg circle title').length"),0);
  await shot('analytics-comparison.png');
  await js("document.getElementById('compare-dialog').dispatchEvent(new PointerEvent('pointerleave'));new Promise(r=>requestAnimationFrame(r))");
  assert.equal(await js("document.getElementById('compare-hover-tip').classList.contains('hidden')"),true);
  await js("document.getElementById('compare-close').click();openSubscriberChart(appState.channels[0].id);document.querySelector('[data-chart-range=\"7d\"]').click();document.getElementById('subscriber-chart-mode').value='daily';document.getElementById('subscriber-chart-mode').dispatchEvent(new Event('change'))");
  assert.equal(await js("detailChartModel.displayMode"),'daily');
  const scroll = await js("({outerOverflow:getComputedStyle(document.getElementById('subscriber-dialog')).overflowY,bodyOverflow:getComputedStyle(document.body).overflowY,outerExcess:document.getElementById('subscriber-dialog').scrollHeight-document.getElementById('subscriber-dialog').clientHeight,innerExcess:document.querySelector('.subscriber-detail').scrollHeight-document.querySelector('.subscriber-detail').clientHeight})");
  assert.equal(scroll.outerOverflow,'hidden');assert.equal(scroll.bodyOverflow,'hidden');assert.ok(scroll.outerExcess<=2);assert.ok(scroll.innerExcess>0);
  await shot('analytics-subscriber.png');
  win.setSize(900,660);await shot('analytics-small.png');
  await new Promise(resolve => { win.webContents.once('did-finish-load', resolve); win.reload(); });
  for(let i=0;i<50;i++){try{if(await js("!!appState"))break}catch{} await new Promise(r=>setTimeout(r,100));}
  await js("openSubscriberChart(appState.channels[0].id)");assert.equal(await js("subscriberChartRange"),'7d');assert.equal(await js("detailChartModel.displayMode"),'daily');
  await js("document.getElementById('subscriber-close').click();openVideoViewChart(appState.channels[0].id,'mFM2hP5LEhM')");assert.equal(await js("videoViewChartRange"),'90d');assert.equal(await js("videoViewChartModel.displayMode"),'daily');
  assert.equal(errors.length,0,errors.join('\n'));
  fs.writeFileSync(path.join(output,'analytics-smoke-result.json'),JSON.stringify({packaged,passed:true,scroll,checks:['library','search','thumbnail-open','comparison','mode-switch','range-reopen','reload-persistence','single-scroll','small-window','next-frame-hover','100-events-one-frame','leave-cancels-hover','status-delta-keeps-chart']},null,2));
  app.exit(0);
 }catch(error){fs.writeFileSync(path.join(output,'analytics-smoke-error.txt'),error.stack);console.error(error);app.exit(1)}
});
