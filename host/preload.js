'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['viewer-join', 'viewer-leave', 'signal-in', 'allowed-changed', 'tray-stop', 'remote-status', 'invite-used', 'hls-start', 'hls-stop', 'roku-status'];

contextBridge.exposeInMainWorld('ecast', {
  sources: () => ipcRenderer.invoke('sources'),
  selectSource: (id, audio) => ipcRenderer.invoke('select-source', id, audio),
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  shareState: (state) => ipcRenderer.send('share-state', state),
  signalOut: (id, msg) => ipcRenderer.send('signal-out', id, msg),
  kick: (id) => ipcRenderer.send('kick', id),
  allowedList: () => ipcRenderer.invoke('allowed-list'),
  allowedForget: (deviceId) => ipcRenderer.invoke('allowed-forget', deviceId),
  remoteGet: () => ipcRenderer.invoke('remote-get'),
  remoteSet: (patch) => ipcRenderer.invoke('remote-set', patch),
  inviteCreate: () => ipcRenderer.invoke('invite-create'),
  hlsSegment: (seg) => ipcRenderer.send('hls-segment', seg),
  hlsError: (msg) => ipcRenderer.send('hls-error', msg),
  on: (channel, fn) => {
    if (EVENTS.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
