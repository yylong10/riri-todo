(function (root, factory) {
  const Model = typeof module === 'object' && module.exports ? require('./task-model.js') : root.DailyTodoModel;
  const api = factory(Model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DailyTodoStorage = api;
})(globalThis, function (Model) {
  'use strict';
  const KEY = 'daily-todo-v1'; // Preserve the existing file-origin data location.
  const MIGRATION_KEY = 'ririto.before-schema-v2';

  function createStore(storage) {
    let expectedRaw;
    function load() {
      const raw = storage.getItem(KEY);
      const model = raw ? Model.parse(raw) : Model.normalize({ tasks: [] });
      expectedRaw = raw;
      if (raw && JSON.parse(raw).schemaVersion !== Model.SCHEMA_VERSION) {
        // Keep the exact old bytes before the first migration; never overwrite this snapshot.
        if (storage.getItem(MIGRATION_KEY) === null) storage.setItem(MIGRATION_KEY, raw);
        return save(model);
      }
      return model;
    }
    function save(model) {
      if (storage.getItem(KEY) !== expectedRaw) throw Error('其他窗口已修改数据，请刷新后重试；本次未覆盖已有记录');
      const next = Model.normalize(model);
      next.revision++;
      const raw = JSON.stringify(Model.serialize(next));
      storage.setItem(KEY, raw);
      expectedRaw = raw;
      return next;
    }
    return { load, save };
  }
  return { KEY, MIGRATION_KEY, createStore };
});
