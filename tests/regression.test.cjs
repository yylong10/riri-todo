'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Model = require('../assets/task-model.js');
const Storage = require('../assets/task-storage.js');
let passed = 0;
function test(name, fn) { fn(); passed++; console.log('PASS ' + name); }
const task = (id, extra = {}) => ({ id, text: id, parentId: null, state: 'pending', createdDate: '2026-10-19', completedDate: null, heldDate: null, ddlMode: 'date', ddl: '2026-10-19', ...extra });
const model = tasks => Model.normalize({ tasks });
function memory(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), values };
}

test('old buckets and version-1 backups migrate without changing DDL', () => {
  const days = { '2026-09-01': [{ id: 'a', text: 'old', done: false, state: 'delayed', ddl: '2026-08-20' }, { id: 'b', text: 'held', done: false, state: 'cancelled' }, { id: 'c', text: 'done', done: true }] };
  const result = Model.parse({ version: 1, days });
  assert.deepEqual(result.tasks.map(t => t.state), ['pending', 'held', 'completed']);
  assert.equal(result.tasks[0].ddl, '2026-08-20');
  assert.equal(result.tasks[1].heldDate, '2026-09-01');
  assert.equal(result.tasks[2].completedDate, '2026-09-01');
});
test('v2 roundtrip contains no redundant done flag or inherited date', () => {
  const before = model([task('root'), task('child', { parentId: 'root', ddlMode: 'inherit' })]);
  const backup = Model.backup(before, new Date('2026-10-19T00:00:00Z'));
  assert.equal(backup.data.tasks[0].done, undefined);
  assert.deepEqual(backup.data.tasks[1].deadline, { mode: 'inherit', date: null });
  assert.deepEqual(Model.parse(JSON.stringify(backup)), before);
});
test('all child deadlines follow the root, including older independent values', () => {
  const result = model([task('a', { ddl: '2030-01-01' }), task('b', { parentId: 'a', ddlMode: 'inherit' }), task('c', { parentId: 'b', ddlMode: 'inherit' }), task('d', { parentId: 'a', ddl: '2031-01-01' }), task('e', { parentId: 'a', ddlMode: 'long' })]);
  assert.deepEqual(result.tasks.map(t => t.ddl), ['2030-01-01', '2030-01-01', '2030-01-01', '2030-01-01', '2030-01-01']);
});
test('bad dates, duplicate IDs, cycles and unknown schema are rejected', () => {
  assert.throws(() => model([task('x', { ddl: '2026-02-30' })]));
  assert.throws(() => model([task('x'), task('x')]));
  assert.throws(() => model([task('a', { parentId: 'b' }), task('b', { parentId: 'a' })]));
  assert.throws(() => Model.parse({ schemaVersion: 999, tasks: [] }));
});
test('merge appends incoming tasks and keeps all local tasks', () => {
  const local = model([task('local')]), incoming = model([task('imported')]);
  const { model: result, stats } = Model.merge(local, incoming);
  assert.deepEqual(result.tasks.map(t => t.id), ['local', 'imported']);
  assert.deepEqual(stats, { added: 1, identical: 0, conflicts: 0 });
  assert.equal(local.tasks.length, 1); // merge is pure
});
test('duplicate backups are idempotent, conflicting IDs keep local content', () => {
  const local = model([task('x', { text: 'local text' })]);
  const incoming = model([task('x', { text: 'older text' }), task('y')]);
  const first = Model.merge(local, incoming);
  assert.equal(first.model.tasks[0].text, 'local text');
  assert.deepEqual(first.stats, { added: 1, identical: 0, conflicts: 1 });
  assert.deepEqual(Model.merge(first.model, incoming).stats, { added: 0, identical: 1, conflicts: 1 });
});
test('same task text with different IDs is preserved as separate records', () => {
  assert.equal(Model.merge(model([task('a', { text: 'same' })]), model([task('b', { text: 'same' })])).model.tasks.length, 2);
});
test('parent-child relationships survive merge and union cycles are rejected', () => {
  const result = Model.merge(model([task('parent')]), model([task('child', { parentId: 'parent', ddlMode: 'inherit' })]));
  assert.equal(result.model.tasks[1].ddl, '2026-10-19');
  assert.throws(() => Model.merge(model([task('a', { parentId: 'b' })]), model([task('b', { parentId: 'a' })])));
});
test('archives use operation dates, not creation buckets', () => {
  const result = Model.archiveIndex([task('a'), task('b', { state: 'completed', completedDate: '2026-09-20' }), task('c', { state: 'held', heldDate: '2026-09-21' })]);
  assert.equal(result.pending.length, 1);
  assert.deepEqual(result.months.get('2026-09'), { done: 1, held: 1 });
});
test('partially completed trees stay together in Todo, with nothing prematurely in Done', () => {
  const result = Model.archiveIndex(model([
    task('parent'), task('child', { parentId: 'parent', state: 'completed', completedDate: '2026-10-18' }),
    task('grandchild', { parentId: 'child', state: 'completed', completedDate: '2026-10-17' }),
  ]).tasks);
  assert.equal(result.pending.length, 3);
  assert.equal(result.pending.filter(t => t.state === 'pending').length, 1);
  assert.equal(result.done.size, 0);
});
test('fully completed trees enter Done once, on the latest completion date', () => {
  const result = Model.archiveIndex(model([
    task('parent', { state: 'completed', completedDate: '2026-10-19' }),
    task('child', { parentId: 'parent', state: 'completed', completedDate: '2026-09-01' }),
  ]).tasks);
  assert.equal(result.pending.length, 0);
  assert.equal(result.done.size, 1);
  assert.equal(result.done.get('2026-10-19').length, 2);
  assert.equal(result.months.has('2026-09'), false);
});
test('held groups do not leave completed children isolated in Done', () => {
  const result = Model.archiveIndex(model([
    task('parent', { state: 'held', heldDate: '2026-10-19' }),
    task('child', { parentId: 'parent', state: 'completed', completedDate: '2026-10-18' }),
  ]).tasks);
  assert.equal(result.done.size, 0);
  assert.equal(result.held.get('2026-10-19').length, 2);
  assert.deepEqual(result.months.get('2026-10'), { done: 0, held: 1 });
});
test('manual order persists without changing parent-child relationships', () => {
  const before = model([task('a'), task('b'), task('child', { parentId: 'a' })]);
  const after = Model.reorder(before, 'b', 'a', 'before');
  assert.ok(after.tasks.find(t => t.id === 'b').order < after.tasks.find(t => t.id === 'a').order);
  assert.equal(after.tasks.find(t => t.id === 'child').parentId, 'a');
  assert.deepEqual(Model.parse(Model.backup(after)), after);
  assert.throws(() => Model.reorder(after, 'child', 'b'));
});
test('storage migration preserves exact original bytes before writing v2', () => {
  const old = JSON.stringify({ '2026-10-19': [{ id: 'x', text: 'x', done: false }] });
  const db = memory({ [Storage.KEY]: old }), store = Storage.createStore(db);
  const result = store.load();
  assert.equal(result.tasks.length, 1);
  assert.equal(db.getItem(Storage.MIGRATION_KEY), old);
  assert.equal(JSON.parse(db.getItem(Storage.KEY)).schemaVersion, 2);
  store.load(); assert.equal(db.getItem(Storage.MIGRATION_KEY), old);
});
test('stale windows cannot silently overwrite newer data', () => {
  const db = memory(), a = Storage.createStore(db), b = Storage.createStore(db);
  a.load(); b.load(); a.save(model([task('a')]));
  assert.throws(() => b.save(model([task('b')])), /其他窗口/);
  assert.equal(Model.parse(db.getItem(Storage.KEY)).tasks[0].id, 'a');
  const fresh = b.load(); fresh.tasks.push(task('b')); b.save(fresh);
  assert.equal(Model.parse(db.getItem(Storage.KEY)).tasks.length, 2);
});
test('bad storage and quota failures do not replace existing records', () => {
  const broken = memory({ [Storage.KEY]: '{bad' });
  assert.throws(() => Storage.createStore(broken).load());
  assert.equal(broken.getItem(Storage.KEY), '{bad');
  const db = memory(), store = Storage.createStore(db);store.load();
  const originalSet = db.setItem;db.setItem = () => { throw Error('quota'); };
  assert.throws(() => store.save(model([task('x')])));
  assert.equal(db.getItem(Storage.KEY), null);
  db.setItem = originalSet;assert.equal(store.save(model([task('x')])).revision, 1);
});

function browserHarness() {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const elements = {}, timers = new Map(), db = memory(), clock = { now: Date.now() };let document, serial = 0, timerId = 0;
  class MockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); }static now() { return clock.now; } }
  class Element {
    constructor(tag = 'div') { this.tag = tag;this.children = [];this.value = '';this.checked = false;this.hidden = false;this.style = {};this.handlers = {};this.isConnected = true;this.classList = { add() {}, remove() {}, toggle() {} }; }
    append(...items) { this.children.push(...items);for (const item of items) { item.parentElement = this;if (item.id) elements[item.id] = item; } }
    prepend(...items) { this.children.unshift(...items); }
    get nextSibling() { const list=this.parentElement?.children||[];return list[list.indexOf(this)+1]||null; }
    insertBefore(item,next) { if(item===next)return;if(item.parentElement){const list=item.parentElement.children;list.splice(list.indexOf(item),1);}const index=next?this.children.indexOf(next):this.children.length;this.children.splice(index,0,item);item.parentElement=this; }
    removeAttribute() {}
    replaceChildren(...items) { this.children = items; }
    setAttribute() {}
    add(item) { this.children.push(item); }
    focus() { document.activeElement = this; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    scrollIntoView() {}
    closest(selector) { let node = this;while (node) { if ((node.className || '').split(' ').includes(selector.slice(1))) return node;node = node.parentElement; }return null; }
    contains(node) { return node === this || this.children.some(child => child.contains && child.contains(node)); }
    getBoundingClientRect() { return { top: 0, height: 60 }; }
    querySelectorAll(tag) { return this.children.flatMap(item => [...(item.tag === tag ? [item] : []), ...(item.querySelectorAll ? item.querySelectorAll(tag) : [])]); }
    querySelector(tag) { return this.querySelectorAll(tag)[0]; }
  }
  for (const match of html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) { elements[match[3]] = new Element(match[1]);elements[match[3]].hidden = /\shidden(?:\s|$)/.test(match[2]); }
  document = { getElementById: id => elements[id], createElement: tag => new Element(tag), addEventListener() {}, body: { style: {} }, activeElement: null };
  const context = vm.createContext({ document, window: { addEventListener() {} }, localStorage: db, Option: function (text, value) { this.text = text;this.value = value; }, Date: MockDate, crypto: { randomUUID: () => 'test-' + (++serial) }, setInterval() {}, setTimeout: (fn, delay) => { timers.set(++timerId, { fn, due: clock.now + delay });return timerId; }, clearTimeout: id => timers.delete(id) });
  for (const filename of ['assets/task-model.js', 'assets/task-storage.js', 'assets/todo-app.js']) new vm.Script(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), { filename }).runInContext(context);
  return { elements, db, tasks: () => Model.parse(db.getItem(Storage.KEY) || { schemaVersion: 2, tasks: [] }).tasks,
    advance(ms) { clock.now += ms;for (const [id, timer] of [...timers]) if (timer.due <= clock.now) { timers.delete(id);timer.fn(); } },
  };
}

test('debug clock sets creation/archive dates and refresh resets to real today', () => {
  const h = browserHarness(), e = h.elements;
  assert.equal(e.date, undefined);
  e.debugDate.value = '2030-05-01';e.debugApply.onclick();
  e.todoInput.value = 'debug task';e.todoForm.onsubmit({ preventDefault() {} });
  assert.equal(h.tasks()[0].createdDate, '2030-05-01');
  assert.equal(h.tasks()[0].ddl, '2030-05-01');
  const checkbox = e.records.querySelectorAll('input').find(item => item.type === 'checkbox');checkbox.onchange();
  assert.equal(h.tasks()[0].completedDate, '2030-05-01');
  e.debugReset.onclick();assert.equal(e.debugDate.value, Model.formatDay());
  assert.equal(h.tasks()[0].completedDate, '2030-05-01');
});

test('simple children inherit DDL and only expose checkbox, text and delete', () => {
  const h=browserHarness(),e=h.elements;
  const row=name=>e.records.querySelectorAll('div').find(item=>(item.className||'').split(' ')[0]==='task'&&item.children.some(child=>child.className==='label'&&child.textContent===name));
  const state=(name,value)=>{const select=row(name).querySelector('select');select.value=value;select.onchange()};
  e.newSubtaskButton.onclick();let line=e.newSubtasks.children[0].children[0];line.children[0].value='child';line.children[0].oninput();
  assert.equal(line.querySelectorAll('select').length,0);assert.equal(line.querySelectorAll('button').length,1);
  e.newSubtaskButton.onclick();line=e.newSubtasks.children[1].children[0];line.children[0].value='child-two';line.children[0].oninput();
  e.todoInput.value='parent';e.ddl.value='2031-01-01';e.todoForm.onsubmit({preventDefault(){}});
  assert.equal(h.tasks().length,3);assert.ok(h.tasks().every(t=>t.ddl==='2031-01-01'));
  assert.equal(row('child').children.length,3);assert.equal(row('child').querySelectorAll('select').length,0);assert.equal(row('child').querySelectorAll('button').length,1);
  state('parent','completed');assert.equal(e.actionPanel.hidden,false);e.actionAccept.onclick();assert.ok(h.tasks().every(t=>t.state==='completed'));
  assert.equal(e.undoBar.hidden,true);row('child').querySelector('input').onchange();row('child-two').querySelector('input').onchange();assert.ok(h.tasks().every(t=>t.state==='pending'));
  state('parent','held');e.actionAlternative.onclick();assert.equal(h.tasks().find(t=>t.text==='parent').state,'held');assert.equal(h.tasks().find(t=>t.text==='child').state,'pending');
  const delay=row('parent').querySelectorAll('button').find(item=>item.className==='delay-button');delay.onclick();assert.equal(h.tasks().find(t=>t.text==='parent').state,'held');assert.ok(h.tasks().every(t=>t.ddl==='2031-01-02'));
  row('child').querySelector('button').onclick();e.deleteAccept.onclick();assert.equal(h.tasks().length,2);e.undoButton.onclick();assert.equal(h.tasks().length,3);
  row('parent').querySelectorAll('button').find(item=>item.textContent==='删除').onclick();e.deleteAccept.onclick();assert.equal(h.tasks().length,0);e.undoButton.onclick();assert.equal(h.tasks().length,3);
});

test('drag handle reorders visible siblings and persists the result without undo', () => {
  const h = browserHarness(), e = h.elements;
  for (const text of ['one', 'two', 'three']) { e.todoInput.value = text;e.todoForm.onsubmit({ preventDefault() {} }); }
  const row = name => e.records.querySelectorAll('div').find(item => (item.className || '').split(' ')[0] === 'task' && item.children.some(child => child.className === 'label' && child.textContent === name));
  const source = row('three'), target = row('one');
  const handle = source.querySelectorAll('button').find(item => item.className === 'drag-handle');
  handle.ondragstart({ dataTransfer: { setData() {} }, stopPropagation() {} });
  target.parentElement.ondragover({ clientY: 0, preventDefault() {}, stopPropagation() {}, dataTransfer: {} });
  target.parentElement.ondrop({ clientY: 0, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(h.tasks().slice().sort((a, b) => a.order - b.order).map(t => t.text), ['three', 'one', 'two']);
  assert.equal(e.undoBar.hidden, true);
});

test('tree drag uses the full card midpoint and a whole-card drag image', () => {
  const h = browserHarness(), e = h.elements;
  const row = name => e.records.querySelectorAll('div').find(item => (item.className || '').split(' ')[0] === 'task' && item.children.some(child => child.className === 'label' && child.textContent === name));
  e.newSubtaskButton.onclick();const childInput = e.newSubtasks.children[0].children[0].children[0];childInput.value = 'nested';childInput.oninput();
  e.todoInput.value = 'large tree';e.todoForm.onsubmit({ preventDefault() {} });
  e.todoInput.value = 'move me';e.todoForm.onsubmit({ preventDefault() {} });
  const source = row('move me'), target = row('large tree'), card = target.parentElement;
  card.getBoundingClientRect = () => ({ top: 100, height: 240 });
  target.getBoundingClientRect = () => ({ top: 100, height: 38 });
  let dragImage;
  source.querySelectorAll('button').find(item => item.className === 'drag-handle').ondragstart({ dataTransfer: { setData() {}, setDragImage(element) { dragImage = element; } }, stopPropagation() {} });
  assert.equal(dragImage, source.parentElement);
  assert.equal(target.ondragover, undefined);
  card.ondragover({ clientY: 160, preventDefault() {}, stopPropagation() {}, dataTransfer: {} });
  card.ondrop({ clientY: 160, preventDefault() {}, stopPropagation() {} });
  const roots = h.tasks().filter(task => !task.parentId).sort((a, b) => a.order - b.order);
  assert.deepEqual(roots.map(task => task.text), ['move me', 'large tree']);
  assert.equal(h.tasks().find(task => task.text === 'nested').parentId, roots[1].id);
});

test('drag hover previews DOM order without saving; cancel restores and placeholder drop commits', () => {
 const h=browserHarness(),e=h.elements;
 for(const text of ['a','b','c']){e.todoInput.value=text;e.todoForm.onsubmit({preventDefault(){}})}
 const row=name=>e.records.querySelectorAll('div').find(item=>(item.className||'').split(' ')[0]==='task'&&item.children.some(child=>child.className==='label'&&child.textContent===name));
 const source=row('c').parentElement,target=row('a').parentElement,parent=source.parentElement,handle=row('c').querySelectorAll('button').find(b=>b.className==='drag-handle');
 const order=()=>parent.children.filter(n=>n.taskId).map(n=>n.taskId);
 const original=order(),stored=h.db.getItem(Storage.KEY),event={clientY:0,preventDefault(){},stopPropagation(){},dataTransfer:{setData(){}}};
 handle.ondragstart(event);target.ondragover(event);
 assert.equal(order()[0],source.taskId);assert.equal(h.db.getItem(Storage.KEY),stored);
 handle.ondragend();assert.deepEqual(order(),original);assert.equal(h.db.getItem(Storage.KEY),stored);
 handle.ondragstart(event);target.ondragover(event);source.ondrop(event);
 assert.deepEqual(h.tasks().slice().sort((a,b)=>a.order-b.order).map(t=>t.text),['c','a','b']);
});

test('rapid deletions retain separate timers and can be restored independently', () => {
  const h = browserHarness(), e = h.elements;
  for (const name of ['first', 'second', 'third']) { e.todoInput.value = name;e.todoForm.onsubmit({ preventDefault() {} }); }
  const row = name => e.records.querySelectorAll('div').find(item => (item.className || '').split(' ')[0] === 'task' && item.children.some(child => child.className === 'label' && child.textContent === name));
  const remove = name => { row(name).querySelectorAll('button').find(item => item.textContent === '删除').onclick();e.deleteAccept.onclick(); };
  remove('first');h.advance(4000);remove('second');h.advance(4000);remove('third');
  assert.equal(e.undoList.children.length, 3);
  assert.deepEqual(e.undoList.children.map(item => item.children[2].textContent), ['剩余 15 秒', '剩余 11 秒', '剩余 7 秒']);
  h.advance(7000);assert.equal(e.undoList.children.length, 2);
  assert.match(e.undoList.children[0].children[0].textContent, /third/);
  assert.match(e.undoList.children[1].children[0].textContent, /second/);
  e.undoList.children[1].children[1].onclick();assert.equal(e.undoList.children.length, 1);
  assert.deepEqual(h.tasks().map(t => t.text), ['second']);
  e.todoInput.value = 'new task';e.todoForm.onsubmit({ preventDefault() {} });
  e.undoList.children[0].children[1].onclick();
  assert.equal(e.undoBar.hidden, true);
  assert.deepEqual(h.tasks().map(t => t.text).sort(), ['new task', 'second', 'third']);
});

module.exports = (async () => {
  const h = browserHarness(), e = h.elements;
  e.todoInput.value = 'local task';e.todoForm.onsubmit({ preventDefault() {} });
  const localId = h.tasks()[0].id;
  const imported = Model.backup(model([task('imported'), task(localId, { text: 'conflicting old text' })]));
  await e.file.onchange({ target: { files: [{ size: 100, text: async () => JSON.stringify(imported) }], value: 'x' } });
  assert.equal(h.tasks().length, 1);e.actionAccept.onclick();
  assert.equal(h.tasks().length, 2);assert.equal(h.tasks().find(t => t.id === localId).text, 'local task');
  assert.match(e.status.textContent, /新增 1 条/);assert.equal(e.undoBar.hidden, true);
  await e.file.onchange({ target: { files: [{ size: 10, text: async () => '{bad' }], value: 'x' } });
  assert.equal(h.tasks().length, 2);assert.equal(e.errorBanner.hidden, false);
  console.log('PASS UI import preview, additive merge, conflicts, no undo and invalid backup');
  console.log(`${passed + 1} tests passed`);
  return { passed: passed + 1 };
})();
if (require.main === module) module.exports.catch(error => { console.error(error);process.exitCode = 1; });

