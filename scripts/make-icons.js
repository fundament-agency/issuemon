'use strict';
/* Generates the icons from SVG via a hidden Electron window.  Usage: npm run icons */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');

// "Mon": a little monster with one big eye that keeps watch over your issues. The orange ball on the antenna is the notification.
// Clay terracotta on a warm cream tile, matching the app's palette.
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf6ef"/><stop offset="1" stop-color="#e8dccb"/></linearGradient>
    <linearGradient id="body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#da8c61"/><stop offset="1" stop-color="#ad5530"/></linearGradient>
    <radialGradient id="iris" cx=".42" cy=".38" r=".7"><stop offset="0" stop-color="#f6c77c"/><stop offset="1" stop-color="#c47f27"/></radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".35" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="18" flood-color="#2a1e14" flood-opacity=".32"/></filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#6b2f14" flood-opacity=".28"/></filter>
    <filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="16"/></filter>
    <clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#sh)"/>
  <g clip-path="url(#tile)">
    <g fill="none" stroke="#c06a40" stroke-width="24" stroke-linecap="round">
      <path d="M428 350 Q404 262 360 210"/><path d="M596 350 Q620 262 664 210"/>
    </g>
    <circle cx="352" cy="196" r="34" fill="#fbf1e4" stroke="#c06a40" stroke-width="10"/>
    <circle cx="672" cy="194" r="70" fill="#e8a24f" fill-opacity=".55" filter="url(#glow)"/>
    <circle cx="672" cy="194" r="38" fill="#eaa652"/>
    <circle cx="660" cy="182" r="11" fill="#fff4e2"/>
    <path d="M222 1000V610C222 428 352 306 512 306S802 428 802 610V1000Z" fill="url(#body)" filter="url(#soft)"/>
    <ellipse cx="372" cy="430" rx="92" ry="44" fill="#fff" fill-opacity=".14" transform="rotate(-38 372 430)"/>
    <circle cx="512" cy="566" r="160" fill="#7a3518" fill-opacity=".22"/>
    <circle cx="512" cy="558" r="156" fill="#fffaf3"/>
    <circle cx="556" cy="522" r="86" fill="url(#iris)"/>
    <circle cx="566" cy="514" r="46" fill="#2a2622"/>
    <circle cx="588" cy="490" r="17" fill="#fff"/>
    <circle cx="546" cy="544" r="7" fill="#fff" fill-opacity=".8"/>
    <path d="M458 796Q512 834 566 796" fill="none" stroke="#5c2814" stroke-width="16" stroke-linecap="round"/>
  </g>
  <rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="url(#rim)" stroke-width="3"/>
</svg>`;

// Menu bar (macOS template: black + transparency only; tray.png for other platforms is grey)
const trayIcon = (color, size) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}">
  <g fill="none" stroke="${color}" stroke-width="${size <= 18 ? 2 : 1.8}" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
    <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
  </g></svg>`;

const jobs = [
  { file: 'build/icon.png', size: 1024, svg: appIcon },
  { file: 'src/assets/icon.png', size: 512, svg: appIcon },
  { file: 'src/assets/trayTemplate.png', size: 18, svg: trayIcon('#000', 18) },
  { file: 'src/assets/trayTemplate@2x.png', size: 36, svg: trayIcon('#000', 36) },
  { file: 'src/assets/tray.png', size: 16, svg: trayIcon('#5b6170', 16) },
  { file: 'src/assets/tray@2x.png', size: 32, svg: trayIcon('#5b6170', 32) },
];

async function render(svg, size) {
  const win = new BrowserWindow({ width: size, height: size, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(1);
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="display:block;width:${size}px;height:${size}px"></body></html>`;
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`);
  await new Promise(r => setTimeout(r, 150));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.destroy();
  return img.getSize().width === size ? img : img.resize({ width: size, height: size, quality: 'best' });
}

app.on('window-all-closed', () => { /* don't quit between two renders */ });

app.whenReady().then(async () => {
  for (const job of jobs) {
    const img = await render(job.svg, job.size);
    const out = path.join(ROOT, job.file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img.toPNG());
    console.log(`${job.file}  ${img.getSize().width}×${img.getSize().height}`);
  }
  app.quit();
});
