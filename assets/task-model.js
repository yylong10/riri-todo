/* Pure data model. Classic script + CommonJS keeps file:// and Node tests working. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DailyTodoModel = api;
})(globalThis, function () {
  'use strict';
  const SCHEMA_VERSION = 2;
  const FORMAT = 'ririto-backup';

  function formatDay(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function validDate(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      && formatDay(new Date(value + 'T12:00:00')) === value;
  }

  function indexTasks(tasks) {
    const byId = new Map(), children = new Map();
    for (const task of tasks) {
      byId.set(task.id, task);
      if (!children.has(task.parentId)) children.set(task.parentId, []);
      children.get(task.parentId).push(task);
    }
    return { byId, children };
  }

  function normalize(input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.tasks)) throw Error('任务列表格式无效');
    const revision = input.revision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) throw Error('数据修订号无效');
    const tasks = [], ids = new Set();
    for (const source of input.tasks) {
      if (!source || typeof source.id !== 'string' || !source.id || source.id.length > 256 || ids.has(source.id)) throw Error('任务 ID 无效或重复');
      if (typeof source.text !== 'string' || !source.text.trim() || source.text.length > 2000) throw Error('任务文字须为 1–2000 字');
      if (!['pending', 'completed', 'held'].includes(source.state)) throw Error('任务状态无效');
      if (source.parentId != null && (typeof source.parentId !== 'string' || !source.parentId || source.parentId === source.id)) throw Error('父任务 ID 无效');
      if (!validDate(source.createdDate)) throw Error('创建日期无效');
      for (const field of ['completedDate', 'heldDate']) if (source[field] != null && !validDate(source[field])) throw Error('归档日期无效');
      const deadline = source.deadline || { mode: source.ddlMode, date: source.ddl };
      if (!deadline || !['inherit', 'date', 'long'].includes(deadline.mode)) throw Error('期限类型无效');
      if (deadline.mode === 'date' && !validDate(deadline.date)) throw Error('DDL 日期无效');
      if (source.order !== undefined && (!Number.isSafeInteger(source.order) || source.order < 0)) throw Error('任务顺序无效');
      const task = {
        id: source.id, text: source.text.trim(), parentId: source.parentId || null,
        order: source.order ?? tasks.length,
        state: source.state, createdDate: source.createdDate,
        completedDate: source.completedDate || null, heldDate: source.heldDate || null,
        ddlMode: source.parentId ? 'inherit' : deadline.mode, ddl: !source.parentId && deadline.mode === 'date' ? deadline.date : null,
      };
      if (task.state === 'completed' && !task.completedDate) throw Error('已完成任务缺少完成日期');
      if (task.state === 'held' && !task.heldDate) throw Error('搁置任务缺少搁置日期');
      if (task.ddlMode === 'inherit' && !task.parentId) throw Error('根任务不能跟随父任务期限');
      tasks.push(task); ids.add(task.id);
    }
    const { byId, children } = indexTasks(tasks);
    // Topological traversal validates cycles and resolves inherited DDL once per task.
    const queue = tasks.filter(t => !byId.has(t.parentId));
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const task = queue[cursor];
      if (task.ddlMode === 'inherit') task.ddl = byId.get(task.parentId)?.ddl ?? null;
      queue.push(...(children.get(task.id) || []));
    }
    if (queue.length !== tasks.length) throw Error('父子任务存在循环关系');
    return { schemaVersion: SCHEMA_VERSION, revision, tasks };
  }

  function migrateLegacy(days) {
    if (!days || typeof days !== 'object' || Array.isArray(days)) throw Error('旧版备份格式无效');
    const tasks = [];
    for (const [day, rows] of Object.entries(days)) {
      if (!validDate(day) || !Array.isArray(rows)) throw Error('旧版日期分组无效');
      for (const old of rows) {
        if (!old || typeof old.done !== 'boolean') throw Error('旧版任务格式无效');
        const state = old.state === 'cancelled' ? 'held' : old.state === 'delayed' ? 'pending' : old.state || (old.done ? 'completed' : 'pending');
        const ddl = old.ddl === undefined ? day : old.ddl;
        tasks.push({ ...old, state, createdDate: old.createdDate || day,
          completedDate: old.completedDate || (state === 'completed' ? day : null),
          heldDate: old.heldDate || (state === 'held' ? day : null),
          ddlMode: old.ddlMode || (ddl === null ? 'long' : 'date'), ddl,
        });
      }
    }
    return normalize({ tasks, revision: 0 });
  }

  function parse(input) {
    const raw = typeof input === 'string' ? JSON.parse(input) : input;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('数据格式无效');
    if (raw.format === FORMAT) {
      if (raw.schemaVersion !== SCHEMA_VERSION) throw Error('不支持的备份版本');
      return parse(raw.data);
    }
    if (raw.schemaVersion !== undefined) {
      if (raw.schemaVersion !== SCHEMA_VERSION) throw Error('不支持的数据版本');
      return normalize(raw);
    }
    if (raw.version !== undefined) {
      if (raw.version !== 1) throw Error('不支持的旧版备份版本');
      return migrateLegacy(raw.days);
    }
    return migrateLegacy(raw);
  }

  function taskRecord(task) {
    return {
      id: task.id, text: task.text, parentId: task.parentId, state: task.state,
      order: task.order,
      createdDate: task.createdDate, completedDate: task.completedDate, heldDate: task.heldDate,
      deadline: { mode: task.ddlMode, date: task.ddlMode === 'date' ? task.ddl : null },
    };
  }

  function serialize(model) {
    return { schemaVersion: SCHEMA_VERSION, revision: model.revision, tasks: model.tasks.map(taskRecord) };
  }

  function backup(model, now = new Date()) {
    return { format: FORMAT, schemaVersion: SCHEMA_VERSION, exportedAt: now.toISOString(), data: serialize(model) };
  }

  function merge(current, incoming) {
    const local = normalize(current), imported = normalize(incoming), byId = indexTasks(local.tasks).byId;
    const stats = { added: 0, identical: 0, conflicts: 0 };
    for (const task of imported.tasks) {
      const existing = byId.get(task.id);
      if (!existing) { local.tasks.push(task); byId.set(task.id, task); stats.added++; }
      else if (JSON.stringify(taskRecord(existing)) === JSON.stringify(taskRecord(task))) stats.identical++;
      else stats.conflicts++;
    }
    // Validate the union too: two individually valid files may form a cycle when combined.
    return { model: normalize(local), stats };
  }

  function archiveIndex(tasks) {
    const pending = [], done = new Map(), held = new Map(), months = new Map();
    const { byId, children } = indexTasks(tasks);
    function archive(map, date, members, isDone) {
      if (!map.has(date)) map.set(date, []);
      map.get(date).push(...members);
      const month = date.slice(0, 7);
      if (!months.has(month)) months.set(month, { done: 0, held: 0 });
      months.get(month)[isDone ? 'done' : 'held'] += members.filter(t => isDone || t.state === 'held').length;
    }
    for (const root of tasks.filter(t => !byId.has(t.parentId))) {
      const group = [], stack = [root];
      while (stack.length) { const task = stack.pop();group.push(task);stack.push(...(children.get(task.id) || [])); }
      if (group.every(t => t.state === 'completed')) {
        const date = group.reduce((latest, t) => t.completedDate > latest ? t.completedDate : latest, '');
        archive(done, date, group, true);
      } else if (group.some(t => t.state === 'pending')) {
        // Completed children remain alongside unfinished relatives, without inflating Todo counts.
        pending.push(...group.filter(t => t.state !== 'held'));
        for (const task of group.filter(t => t.state === 'held')) archive(held, task.heldDate, [task], false);
      } else {
        // A held group may contain completed children; none should appear alone in Done.
        const date = group.reduce((latest, t) => (t.heldDate || '') > latest ? t.heldDate : latest, '');
        archive(held, date, group, false);
      }
    }
    return { pending, done, held, months };
  }

  function reorder(input, sourceId, targetId, placement = 'before') {
    const model = normalize(input), { byId } = indexTasks(model.tasks);
    const source = byId.get(sourceId), target = byId.get(targetId);
    if (!source || !target || source.parentId !== target.parentId) throw Error('只能调整同级任务顺序');
    if (!['before', 'after'].includes(placement)) throw Error('排序位置无效');
    if (sourceId === targetId) return model;
    const siblings = model.tasks.filter(t => t.parentId === source.parentId).sort((a, b) => a.order - b.order);
    const ordered = siblings.filter(t => t.id !== sourceId);
    ordered.splice(ordered.findIndex(t => t.id === targetId) + (placement === 'after' ? 1 : 0), 0, source);
    ordered.forEach((task, position) => { task.order = position; });
    return model;
  }

  return { SCHEMA_VERSION, FORMAT, formatDay, validDate, normalize, parse, serialize, backup, merge, indexTasks, archiveIndex, reorder };
});
