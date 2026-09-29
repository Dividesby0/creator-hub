'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('hub', {
  license: {
    status: () => call('license:status'),
    eula: () => call('license:eula'),
    check: key => call('license:check', key),
    activateOnline: (key, eula) => call('license:activateOnline', key, eula),
    requestCode: key => call('license:requestCode', key),
    activateOffline: (key, code, eula) => call('license:activateOffline', key, code, eula),
    deactivate: () => call('license:deactivate')
  },
  state: () => call('app:state'),
  openUrl: url => call('app:openUrl', url),
  posts: {
    create: input => call('posts:create', input),
    update: (id, patch) => call('posts:update', id, patch),
    remove: id => call('posts:delete', id),
    approve: ids => call('posts:approve', ids),
    reject: id => call('posts:reject', id),
    submit: id => call('posts:submit', id),
    publishNow: id => call('posts:publishNow', id),
    retry: id => call('posts:retry', id),
    duplicate: id => call('posts:duplicate', id),
    validate: id => call('posts:validate', id)
  },
  pickMedia: () => call('media:pick'),
  importBatch: () => call('batch:import'),
  accounts: {
    save: (pid, values) => call('accounts:save', pid, values),
    connect: pid => call('accounts:connect', pid),
    disconnect: pid => call('accounts:disconnect', pid)
  },
  settings: { update: patch => call('settings:update', patch) },
  analytics: { refresh: () => call('analytics:refresh') },
  on: (evt, fn) => {
    const ok = ['state-changed', 'toast'];
    if (!ok.includes(evt)) return;
    ipcRenderer.on(evt, (_e, data) => fn(data));
  }
});
