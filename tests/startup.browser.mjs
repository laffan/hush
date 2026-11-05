// Install playwright-core outside the checkout and set HUSH_PLAYWRIGHT_MODULE
// to its index.mjs path. Start npm run dev before running this harness.
const { chromium } = await import(process.env.HUSH_PLAYWRIGHT_MODULE || 'playwright-core');
import assert from 'node:assert/strict';
const browser = await chromium.launch({executablePath:'/usr/bin/chromium', headless:true, args:['--no-sandbox','--disable-dev-shm-usage']});
const page = await browser.newPage();
page.on('pageerror', e => console.log('PAGE ERROR',e.message));
await page.route('**/harness', route => route.fulfill({contentType:'text/html',body:'<div id="app"><div id="editor-container"></div><div id="editor-empty-state"></div><div id="notebook-container"></div><div id="pdf-container"></div><div id="stack-container"></div></div>'}));
await page.goto('http://localhost:5173/harness');
const result = await page.evaluate(async () => {
  const calls = [];
  const file = (id,type='document') => ({id:'node-'+id,fileId:id,type,name:id,children:[]});
  const desk = (id, children) => ({id,type:'desk',name:id,children:[{id:'__inbox__:'+id,type:'project',name:'Inbox',children},...['images','archive','trash'].map(k=>({id:`__${k}__:${id}`,type:'folder',name:k,children:[]}))]});
  const tree = [desk('writing',[file('draft'),file('project-doc'),{id:'pj',type:'project',name:'Project',children:[file('project-child')]}]), desk('research',[file('proof','notebook')])];
  const disk = {activeDeskId:'writing',desks:[{id:'writing'},{id:'research'}],lastNotebookId:'proof',lastFileId:'draft'};
  window.__TAURI_INTERNALS__ = { metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}}, transformCallback:()=>1, convertFileSrc:x=>x, invoke:async(cmd,args)=>{
    calls.push([cmd,args]);
    if(cmd==='get_settings') return structuredClone(disk);
    if(cmd==='list_files') return ['draft','project-doc','project-child','proof'].map(id=>({id,name:id,content:null}));
    if(cmd==='get_file_tree') return structuredClone(tree);
    if(cmd==='load_file') return {id:args.id,name:args.id,content:`Body of ${args.id}`,hash:'hash'};
    if(cmd==='patch_settings') {Object.assign(disk,args.patch);return disk;}
    if(cmd==='save_file_tree') return args.tree;
    if(cmd==='file_availability') return {available:true};
    return null;
  }};
  const { AppState } = await import('/src/state/state.js');
  const state = new AppState();
  await state.init();
  clearInterval(state.autosaveInterval);
  const beforeMount = {id:state.currentFileId,notebook:state.currentNotebookFileId,loads:calls.filter(c=>c[0]==='load_file').length};
  const {createEditor} = await import('/src/editor/editor.js');
  state.setEditor(createEditor(document.getElementById('editor-container'),state));
  const {setupModeSwitching} = await import('/src/main-modes.js');
  await setupModeSwitching(state);
  const doc = {body:state.editor.getContent(),loads:calls.filter(c=>c[0]==='load_file').map(c=>c[1].id)};
  state.isSecondaryWindow = true;
  await state.updateSettings({lastPdfId:'foreign-pdf'});
  const pdfOnDisk = disk.lastPdfId ?? null;
  state.isSecondaryWindow = false;
  state.settings.lastPdfId='old-pdf'; state.settings.lastStackId='old-stack';
  await state.openProject('pj');
  const projectSlots={pdf:state.settings.lastPdfId,stack:state.settings.lastStackId,project:state.settings.lastProjectId};
  await state.saveSessionState();
  return {beforeMount,doc,pdfOnDisk,projectSlots};
});
assert.deepEqual(result.beforeMount,{id:'draft',notebook:null,loads:0});
assert.deepEqual(result.doc,{body:'Body of draft',loads:['draft']});
assert.equal(result.pdfOnDisk,null);
assert.deepEqual(result.projectSlots,{pdf:null,stack:null,project:'pj'});
console.log(JSON.stringify(result,null,2));
// Exercise delayed surface lifecycle work independently of native IPC.
const modes = await browser.newPage();
await modes.route('**/harness', route => route.fulfill({contentType:'text/html',body:'<div id="app"><div id="editor-container"></div><div id="editor-empty-state"></div><div id="notebook-container">OLD PROOF CONTENT</div><div id="pdf-container"></div><div id="stack-container"></div></div>'}));
const moduleStubs = {
  '/src/notebook/notebook-bridge.js': `
    export const mountNotebook = () => new Promise(resolve => window.finishNotebook = resolve);
    export const unmountNotebook = () => new Promise(resolve => window.finishUnmount = resolve);
    export const saveNotebook = () => null, getCanvasInstance = () => null, reloadNotebookShapes = async () => {}, isNotebookDirty = () => false;
  `,
  '/src/style-application.js': 'export const applyActiveStyle = () => {};',
  '/src/editor/empty-state.js': 'export const mountEmptyState = () => {};',
  '/src/notebook/minimap.js': 'export const wireMinimap = () => {};',
  '/src/pdf/pdf-bridge.js': 'export const mountPdf = async () => {}; export const unmountPdf = async () => {};',
};
for (const [url, body] of Object.entries(moduleStubs)) await modes.route(`**${url}*`, route => route.fulfill({contentType:'application/javascript',body}));
await modes.goto('http://localhost:5173/harness');
const transition = await modes.evaluate(async () => {
  const handlers = {};
  const state = {settings:{},runtime:{},emit:() => {},on:(event,fn) => {handlers[event]=fn;}};
  const {setupModeSwitching} = await import('/src/main-modes.js');
  await setupModeSwitching(state);
  state.currentNotebookFileId = 'new-proof';
  const notebook = handlers['notebook-open']('new-proof');
  const concealed = document.getElementById('notebook-container').style.visibility === 'hidden';
  const outgoing = handlers['notebook-unmount']();
  state.currentNotebookFileId = null;
  state.currentPdfFileId = 'paper';
  await handlers['pdf-open']('paper');
  window.finishNotebook();
  await notebook;
  window.finishUnmount();
  await outgoing;
  return {concealed, mode:document.body.classList.contains('pdf-mode'), hiddenOldCanvas:document.getElementById('notebook-container').classList.contains('hidden')};
});
assert.deepEqual(transition,{concealed:true,mode:true,hiddenOldCanvas:true});
console.log('Delayed notebook mount/unmount cannot expose old content or replace the PDF:', transition);
await browser.close();
