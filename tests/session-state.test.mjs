import test from 'node:test';
import assert from 'node:assert/strict';
import { startupSurface, restoreStartupSurface, sessionSettings, preserveWindowSettings, PER_WINDOW_SETTINGS_KEYS } from '../src/state/session-state.js';
import { installWindowSession, readWindowSession } from '../src/state/window-session.js';

function fixture(settings = {}) {
  const leaf = (type, id) => ({ id: `node-${id}`, fileId: id, type, children: [] });
  return {
    settings: { activeDeskId: 'writing', ...settings }, runtime: {},
    files: ['draft', 'proof', 'other', 'board'].map(id => ({ id, content: null })),
    fileTree: [
      { id: 'writing', type: 'desk', children: [leaf('document', 'draft'), leaf('notebook', 'board'), leaf('pdf', 'paper'), leaf('stack', 'stack'), { id: 'project', type: 'project', children: [] }] },
      { id: 'research', type: 'desk', children: [leaf('notebook', 'proof'), leaf('document', 'other')] },
    ],
  };
}

test('foreign proofread notebook cannot win over the launch desk document', () => {
  const s = fixture({ lastNotebookId: 'proof', lastFileId: 'draft' });
  assert.deepEqual(startupSurface(s), { fileId: 'draft', fileType: 'document' });
});

test('foreign global slots fall back to this desk, never to the first library file', () => {
  const s = fixture({ lastNotebookId: 'proof', desksMeta: { writing: { lastFileId: 'draft', lastFileType: 'document' } } });
  assert.equal(startupSurface(s).fileId, 'draft');
  delete s.settings.desksMeta;
  assert.equal(startupSurface(s), null);
});

test('explicit new-window requests validate type and desk without opening a fallback', () => {
  const s = fixture({ lastNotebookId: 'proof' });
  assert.equal(startupSurface(s, { initialDesk: 'writing' }), null);
  for (const initialFile of [{ fileId: 'missing', fileType: 'document' }, { fileId: 'proof', fileType: 'notebook' }, { fileId: 'draft', fileType: 'notebook' }]) {
    assert.equal(startupSurface(s, { initialDesk: 'writing', initialFile }), null);
  }
  assert.equal(startupSurface(s, { initialDesk: 'research', initialFile: { fileId: 'proof', fileType: 'notebook' } }).fileId, 'proof');
});

test('all five surfaces seed identity without loading a body or opening a file', () => {
  for (const [type, id, key, pointer] of [
    ['document', 'draft', 'lastFileId', 'currentFileId'],
    ['notebook', 'board', 'lastNotebookId', 'currentNotebookFileId'],
    ['pdf', 'paper', 'lastPdfId', 'currentPdfFileId'],
    ['stack', 'stack', 'lastStackId', 'currentStackFileId'],
    ['project', 'project', 'lastProjectId', 'currentProjectId'],
  ]) {
    const s = fixture({ [key]: id });
    s.openFile = s.openProject = () => assert.fail('premature body load');
    restoreStartupSurface(s);
    assert.equal(s[pointer], id, type);
    const saved = sessionSettings(s);
    assert.equal(saved[key], id);
    assert.equal(Object.values(saved).filter(Boolean).length, 1);
  }
});

test('Local Folder sentinels never persist as library notebook/stack ids', () => {
  const local = { folderId: 'mount', relPath: 'proof.hushnote', kind: 'notebook' };
  const saved = sessionSettings({ currentNotebookFileId: 'ls:mount:proof.hushnote', currentLocalSync: local });
  assert.equal(saved.lastNotebookId, null);
  assert.equal(saved.lastStackId, null);
  assert.deepEqual(saved.lastLocalSync, local);
  const s = fixture({ ...saved, localSyncFolders: [{ id: 'mount', deskId: 'writing' }] });
  restoreStartupSurface(s);
  assert.deepEqual(s.runtime.pendingLocalSync, local);
  s.settings.localSyncFolders[0].deskId = 'research';
  assert.equal(startupSurface(s), null);
});

test('shared settings merges and secondary writes protect every session key', () => {
  for (const key of ['lastPdfId', 'lastStackId', 'lastLocalSync', 'activeDeskId']) assert.ok(PER_WINDOW_SETTINGS_KEYS.has(key), key);
  const own = { lastFileId: 'draft', lastPdfId: null, lastStackId: null, activeDeskId: 'writing', appearance: 'dark' };
  const fresh = { lastPdfId: 'foreign', lastStackId: 'foreign-stack', activeDeskId: 'research', appearance: 'light' };
  const merged = { ...own, ...fresh, ...preserveWindowSettings(own) };
  assert.equal(merged.lastPdfId, null);
  assert.equal(merged.lastStackId, null);
  assert.equal(merged.activeDeskId, 'writing');
  assert.equal(merged.appearance, 'light');
});

test('secondary reload restores its latest surface, including empty, not its original URL', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const listeners = {};
  const previousDocument = globalThis.document;
  globalThis.document = { addEventListener() {} };
  try {
    const s = fixture({ lastNotebookId: 'proof' });
    s.isSecondaryWindow = true;
    s.on = (event, fn) => { listeners[event] = fn; };
    installWindowSession(s, 'window-a', storage);
    s.currentFileId = 'draft';
    listeners['file-opened']();
    const saved = readWindowSession('window-a', storage);
    assert.equal(saved.lastFileId, 'draft');
    assert.equal(saved.lastNotebookId, null);
    assert.equal(readWindowSession('window-b', storage), null);
    s.currentFileId = null;
    listeners['no-file-state']();
    const empty = readWindowSession('window-a', storage);
    const reload = fixture({ ...empty, desksMeta: { writing: { lastFileId: 'board', lastFileType: 'notebook' } } });
    assert.equal(startupSurface(reload, { windowSession: empty }), null);
  } finally { globalThis.document = previousDocument; }
});
