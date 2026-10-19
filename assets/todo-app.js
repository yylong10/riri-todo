/* Interface and interactions. Data validation and storage are separate modules. */
(function () {
'use strict';
const Model=globalThis.DailyTodoModel;
const Storage=globalThis.DailyTodoStorage;
const KEY=Storage.KEY;
const DELETE_UNDO_MS = 15_000;
const MAX_TASK_TEXT_LENGTH = 2_000;
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const validTaskText = text => text.trim().length > 0 && text.trim().length <= MAX_TASK_TEXT_LENGTH;
const validDrafts = drafts => drafts.every(draft => validTaskText(draft.text));
const $=id=>document.getElementById(id);
let debugToday=null;
const localDay=date=>date?Model.formatDay(date):(debugToday||Model.formatDay());
const validDate=Model.validDate;
const validate=Model.normalize;
const newId=()=>crypto.randomUUID?crypto.randomUUID():Date.now()+'-'+Math.random();
let data=Model.normalize({tasks:[]}),store=null,storageOK=true,lastToday=localDay(),undoEntries=[],undoTimer=null;
let indexedSource=null,indexedLength=-1,taskIndex=null;
const taskEdits=new Map(),inlineDrafts=new Map(),newDrafts=[];
function indexes(){if(indexedSource!==data.tasks||indexedLength!==data.tasks.length){taskIndex=Model.indexTasks(data.tasks);indexedSource=data.tasks;indexedLength=data.tasks.length}return taskIndex}
function status(msg,error=false){$('status').textContent=msg;$('status').classList.toggle('error',error);$('errorBanner').hidden=!error;$('errorBanner').textContent=error?msg:''}
// Migration and persistence live in task-storage.js; UI never handles raw legacy buckets.
try{store=Storage.createStore(localStorage);data=store.load()}catch(err){storageOK=false;status('无法读取或保存本地记录：'+err.message,true)}
function allTasks(){return data.tasks}
function findTask(id){return indexes().byId.get(id)}
function isActive(t){return t.state==='pending'}
function isOverdue(t){return isActive(t)&&t.ddl!==null&&t.ddl<localDay()}
function save(){try{data=store.save(data);status('已自动保存 · '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}));return true}catch(err){status('保存失败：'+err.message,true);return false}}
const undoViews=new Map();
function clearUndo(){undoEntries=[];undoViews.clear();if(undoTimer)clearTimeout(undoTimer);undoTimer=null;$('undoList').replaceChildren();$('undoBar').hidden=true}
function renderUndoList(){
 const list=$('undoList');list.replaceChildren();undoViews.clear();$('undoBar').hidden=!undoEntries.length;
 undoEntries.forEach((entry,index)=>{const row=document.createElement('div');row.className='undo-item';const message=document.createElement('span');message.className='undo-item-message';message.textContent=entry.message;message.title=entry.message;const restore=button('撤销',()=>undoDeletion(entry.id));restore.setAttribute('aria-label','撤销删除：'+entry.name);if(index===0)restore.id='undoButton';const countdown=document.createElement('small');countdown.setAttribute('aria-live','off');if(index===0)countdown.id='undoCountdown';row.append(message,restore,countdown);list.append(row);undoViews.set(entry.id,countdown)});
}
function tickUndo(){
 if(undoTimer)clearTimeout(undoTimer);undoTimer=null;const now=Date.now(),before=undoEntries.length;undoEntries=undoEntries.filter(entry=>entry.expires>now);if(before!==undoEntries.length)renderUndoList();if(!undoEntries.length){$('undoBar').hidden=true;return}
 for(const entry of undoEntries){const label=undoViews.get(entry.id);if(label)label.textContent='剩余 '+Math.ceil((entry.expires-now)/1000)+' 秒'}
 undoTimer=setTimeout(tickUndo,Math.min(250,...undoEntries.map(entry=>entry.expires-now)));
}
function makeUndo(before,after){
 const present=new Set(after.tasks.map(t=>t.id)),deleted=before.tasks.filter(t=>!present.has(t.id));if(!deleted.length)return;
 const ids=new Set(deleted.map(t=>t.id)),roots=deleted.filter(t=>!ids.has(t.parentId)),name=roots.map(t=>t.text).join('、'),short=name.length>30?name.slice(0,30)+'…':name;
 undoEntries.unshift({id:newId(),tasks:deleted,name,message:'已删除「'+short+'」'+(deleted.length>roots.length?'及 '+(deleted.length-roots.length)+' 个子任务':''),expires:Date.now()+DELETE_UNDO_MS});renderUndoList();tickUndo();
}
function undoDeletion(id){
 const entry=undoEntries.find(item=>item.id===id);if(!entry||Date.now()>=entry.expires){tickUndo();return}
 if(entry.tasks.some(t=>findTask(t.id))){status('这些记录已经存在，未覆盖当前内容。',true);return}
 const ids=new Set(entry.tasks.map(t=>t.id));if(entry.tasks.some(t=>t.parentId&&!ids.has(t.parentId)&&!findTask(t.parentId))){status('父任务仍在删除状态，请先撤销父任务的删除，再恢复此子任务。',true);return}
 const current=JSON.parse(JSON.stringify(data));data.tasks.push(...entry.tasks);
 try{data=validate(data);for(const task of entry.tasks)if(task.state==='pending')reopenAncestors(findTask(task.id));data=validate(data)}catch(err){data=current;status('无法撤销：'+err.message,true);return}
 if(!save()){data=current;return}undoEntries=undoEntries.filter(item=>item.id!==id);renderUndoList();tickUndo();taskEdits.clear();inlineDrafts.clear();render();status('已恢复「'+entry.name+'」。');
}
function mutate(fn,message='修改已保存',options={}){
 if(!storageOK){status('本地存储异常，已停止修改；请先导出备份。',true);return false}
 const before=JSON.parse(JSON.stringify(data));
 try{fn();data=validate(data)}catch(err){data=before;status('未保存：'+err.message,true);render();return false}
 if(!save()){data=before;render();return false}
 if(options.undo)makeUndo(before,data);render();status(message);return true;
}
function notifyDelay(message){$('delayMessage').textContent=message;$('delayNotice').hidden=false}
$('dismissDelay').onclick=()=>{$('delayNotice').hidden=true};
let pendingAction=null,alternativeAction=null;
function closeAction(){pendingAction=null;alternativeAction=null;$('actionPanel').hidden=true}
function askInline(message,action,label='确认',alternative=null){pendingAction=action;alternativeAction=alternative;$('actionMessage').textContent=message;$('actionAccept').textContent=label;$('actionAlternative').hidden=!alternative;$('actionPanel').hidden=false;$('actionPanel').scrollIntoView({behavior:'smooth',block:'center'})}
$('actionCancel').onclick=closeAction;
$('actionAccept').onclick=()=>{const action=pendingAction;closeAction();if(action)action()};
$('actionAlternative').onclick=()=>{const action=alternativeAction;closeAction();if(action)action()};
function descendantIds(id){const ids=new Set(),stack=[id],children=indexes().children;while(stack.length){const key=stack.pop();if(ids.has(key))continue;ids.add(key);for(const child of children.get(key)||[])stack.push(child.id)}return ids}
function taskPath(t){const path=[],seen=new Set([t.id]);let p=findTask(t.parentId);while(p&&!seen.has(p.id)){seen.add(p.id);path.unshift(p);p=findTask(p.parentId)}return path}
function setState(t,state){t.state=state;if(state==='completed')t.completedDate=localDay();if(state==='held')t.heldDate=localDay()}
function reopenAncestors(t){for(const p of taskPath(t))if(p.state==='completed')setState(p,'pending')}
function changeState(task,state){
 const t=findTask(task.id);if(!t||!['pending','completed','held'].includes(state)||t.state===state)return;
 const ids=descendantIds(t.id),descendants=allTasks().filter(x=>x.id!==t.id&&ids.has(x.id));
 if(state==='completed'&&descendants.some(x=>x.state!=='completed')){
  const count=descendants.filter(x=>x.state!=='completed').length;
  askInline('还有 '+count+' 个子任务未完成（包含搁置项）。是否将父任务及全部子任务一起完成？',()=>{mutate(()=>{const ids=descendantIds(t.id);for(const x of allTasks())if(ids.has(x.id))setState(x,'completed')},'父任务和子任务已完成')},'全部完成');return;
 }
 if(state==='held'&&descendants.some(isActive)){
  const count=descendants.filter(isActive).length;
  askInline('这条任务还有 '+count+' 个待办子任务。是否一起搁置？已完成的子任务保持完成。',()=>{mutate(()=>{const ids=descendantIds(t.id);for(const x of allTasks())if(x.id===t.id||(ids.has(x.id)&&isActive(x)))setState(x,'held')},'父任务及待办子任务已搁置')},'一起搁置',()=>mutate(()=>setState(findTask(t.id),'held'),'父任务已搁置'));return;
 }
 mutate(()=>{const current=findTask(t.id);setState(current,state);if(state==='pending')reopenAncestors(current)},state==='completed'?'任务已完成':state==='held'?'任务已搁置':'已恢复待办');
}
function delayTask(task){
 const t=findTask(task.id);if(!t)return;
 if(t.ddl===null){notifyDelay('“'+t.text+'”为长期任务，可先设置 DDL。');return}
 const date=new Date((t.ddl>localDay()?t.ddl:localDay())+'T12:00:00');date.setDate(date.getDate()+1);const target=localDay(date);
 if(mutate(()=>{findTask(t.id).ddl=target;findTask(t.id).ddlMode='date'},'DDL 已延后一天'))notifyDelay('“'+t.text+'”的 DDL 已改为 '+target+'，状态保持不变。');
}
$('ddl').value=localDay();
function syncDeadlineMode(){const long=$('deadlineMode').value==='long';$('ddl').hidden=long;$('ddl').disabled=long;$('ddl').required=!long;$('ddl').value=long?'':($('ddl').value||localDay())}
$('deadlineMode').value='date';$('deadlineMode').onchange=syncDeadlineMode;syncDeadlineMode();
function editDDL(t){openTaskEditor(t,'ddl')}
function openTaskEditor(t,kind){if(kind==='ddl'&&t.parentId)return;taskEdits.set(t.id,{kind,value:kind==='ddl'?(t.ddl||''):t.text,mode:t.ddlMode||(t.ddl===null?'long':'date'),error:''});render();$('edit-'+t.id)?.querySelector(kind==='ddl'?'select':'input')?.focus()}
function taskEditor(t){
 const draft=taskEdits.get(t.id);if(!draft)return null;
 const form=document.createElement('form');form.noValidate=true;form.id='edit-'+t.id;form.className='task-edit-form';
 const label=document.createElement('label');label.textContent=draft.kind==='ddl'?'修改 DDL':'修改任务文本';label.htmlFor='edit-input-'+t.id;
 const input=document.createElement('input');input.id='edit-input-'+t.id;input.type=draft.kind==='ddl'?'date':'text';input.value=draft.value;input.setAttribute('aria-label',label.textContent);input.maxLength=MAX_TASK_TEXT_LENGTH;input.oninput=()=>draft.value=input.value;
 const mode=document.createElement('select');mode.setAttribute('aria-label','期限类型');mode.add(new Option('指定 DDL','date'));mode.add(new Option('长期','long'));mode.value=draft.mode;
 const sync=()=>{draft.mode=mode.value;input.hidden=mode.value!=='date';input.disabled=input.hidden;if(!input.hidden)input.value=draft.value||localDay();draft.value=input.value};mode.onchange=sync;
 const error=document.createElement('div');error.className='edit-error';error.setAttribute('role','status');error.textContent=draft.error;
 const yes=button('保存',null,'primary');yes.type='submit';const cancel=button('取消',()=>{taskEdits.delete(t.id);render()});
 form.append(label);if(draft.kind==='ddl'){form.append(mode);sync()}form.append(input,yes,cancel,error);
 input.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();taskEdits.delete(t.id);render()}};
 form.onsubmit=e=>{e.preventDefault();const value=input.value.trim();draft.value=value;const message=draft.kind==='text'&&!validTaskText(value)?'请填写 1–2000 个字。':draft.kind==='ddl'&&draft.mode==='date'&&!validDate(value)?'请选择有效日期或长期。':'';if(message){draft.error=message;error.textContent=message;return}if(mutate(()=>{const current=findTask(t.id);if(draft.kind==='text')current.text=value;else{current.ddlMode=draft.mode;current.ddl=draft.mode==='long'?null:value}})){taskEdits.delete(t.id);render()}};return form;
}
function button(text,onclick,cls=''){const b=document.createElement('button');b.type='button';b.textContent=text;b.className=cls;if(onclick)b.onclick=onclick;return b}
// Branch ranks are computed once, then reused by sibling sorting.
function orderedTasks(items){
 const byId=new Map(items.map(t=>[t.id,t])),children=new Map(),roots=[];
 const priority=t=>isOverdue(t)?'0'+t.ddl:'1'+(t.ddl||'9999-12-31');
 for(const task of items){if(byId.has(task.parentId)){if(!children.has(task.parentId))children.set(task.parentId,[]);children.get(task.parentId).push(task)}else roots.push(task)}
 const traversal=[],stack=roots.slice(),seen=new Set();while(stack.length){const t=stack.pop();if(seen.has(t.id))continue;seen.add(t.id);traversal.push(t);stack.push(...(children.get(t.id)||[]))}
 const ranks=new Map();for(let i=traversal.length-1;i>=0;i--){const t=traversal[i];let rank=priority(t);for(const c of children.get(t.id)||[])if(ranks.get(c.id)<rank)rank=ranks.get(c.id);ranks.set(t.id,rank)}
 const compare=(a,b)=>ranks.get(a.id)[0].localeCompare(ranks.get(b.id)[0])||((a.order??0)-(b.order??0))||ranks.get(a.id).localeCompare(ranks.get(b.id));roots.sort(compare);for(const list of children.values())list.sort(compare);
 const result=[],ordered=roots.slice().reverse();while(ordered.length){const t=ordered.pop();result.push(t);ordered.push(...(children.get(t.id)||[]).slice().reverse())}return result;
}
// Both editors and saved tasks use the same tree assembly.
function mountTree(container, tasks, nodes) {
 for (const task of tasks) {
  const node = nodes.get(task.id);
  const parent = nodes.get(task.parentId);
  if (!parent) { container.append(node);continue; }
  if (!parent.treeChildren) {
   parent.classList.add('has-children');
   parent.treeChildren = document.createElement('div');
   parent.treeChildren.className = 'tree-children';
   parent.append(parent.treeChildren);
  }
  parent.treeChildren.append(node);
 }
}
function addDraft(container,drafts,parentId=null){const id=newId();drafts.push({id,parentId,text:''});draftEditor(container,drafts);container.querySelectorAll('input').forEach(i=>{if(i.id==='draft-'+id)i.focus()})}
function draftEditor(container,drafts){
 container.replaceChildren();const nodes=new Map(),ordered=orderedTasks(drafts);
 for(const d of ordered){
  const node=document.createElement('div');node.className='tree-node draft-tree-node';nodes.set(d.id,node);
  const line=document.createElement('div');line.className='draft-line';
  const input=document.createElement('input');input.id='draft-'+d.id;input.type='text';input.maxLength=MAX_TASK_TEXT_LENGTH;input.value=d.text;input.placeholder='填写子任务…';input.setAttribute('aria-label','子任务');input.oninput=()=>d.text=input.value;
  const remove=button('移除',()=>{const ids=new Set([d.id]);let more=true;while(more){more=false;for(const x of drafts)if(ids.has(x.parentId)&&!ids.has(x.id)){ids.add(x.id);more=true}}for(let i=drafts.length-1;i>=0;i--)if(ids.has(drafts[i].id))drafts.splice(i,1);draftEditor(container,drafts)});
  line.append(input,remove);node.append(line);
 }
 mountTree(container, ordered, nodes);
 container.hidden=!drafts.length;
 if(container.id==='newSubtasks')container.parentElement?.classList.toggle('has-children',drafts.length>0);
}
function makeTask(text,day,ddl,parentId=null,id=newId()){return {id,text,ddl,parentId,state:'pending',ddlMode:ddl===null?'long':'date',createdDate:day,completedDate:null,heldDate:null}}
function appendDrafts(day, parent, drafts) {
 for (const draft of drafts) {
  const owner = findTask(draft.parentId || parent.id) || parent;
  const task = makeTask(draft.text.trim(), day, owner.ddl, owner.id, draft.id);
  task.ddlMode = 'inherit';
  data.tasks.push(task);
 }
}
function addSubtask(parent){if(inlineDrafts.has(parent.id))return;inlineDrafts.set(parent.id,[{id:newId(),parentId:null,text:''}]);render();$('subform-'+parent.id)?.querySelector('input')?.focus()}
function inlineEditor(parent){
 const drafts=inlineDrafts.get(parent.id);if(!drafts)return null;
 const form=document.createElement('form');form.noValidate=true;form.id='subform-'+parent.id;form.className='inline-subtask-form draft-root has-children';const title=document.createElement('div');title.className='inline-title';title.textContent='添加子任务';const area=document.createElement('div');area.className='draft-area tree-children';draftEditor(area,drafts);title.prepend(button('+',()=>addDraft(area,drafts),'task-add'));const buttons=document.createElement('div');buttons.className='inline-buttons';const yes=button('保存子任务',null,'primary');yes.type='submit';buttons.append(yes,button('取消',()=>{inlineDrafts.delete(parent.id);render()}));form.append(title,area,buttons);
 form.onsubmit=e=>{e.preventDefault();if(!drafts.length||!validDrafts(drafts)){status('请填写子任务内容（最多 2000 字）。',true);return}
  const commit=()=>{const current=findTask(parent.id);if(!current){status('父任务已不存在。',true);return}if(mutate(()=>{if(current.state==='completed')setState(current,'pending');reopenAncestors(current);appendDrafts(localDay(),current,drafts)},'子任务已保存')){inlineDrafts.delete(parent.id);render()}};
  const needsRestore=[findTask(parent.id),...taskPath(parent)].some(t=>t?.state==='completed');
  if(needsRestore)askInline('保存新子任务会将已完成的父任务及相关上级恢复为待办。继续？',commit,'恢复并保存');else commit();
 };return form;
}
let pendingDelete=null,deleteReturnFocus=null;
function closeDelete(){pendingDelete=null;$('deleteOverlay').hidden=true;$('appMain').inert=false;document.body.style.overflow='';const target=deleteReturnFocus;deleteReturnFocus=null;if(target?.isConnected)target.focus();else $('todoInput').focus()}
function deleteTask(t){const count=descendantIds(t.id).size-1;pendingDelete=t.id;deleteReturnFocus=document.activeElement;$('deleteTaskName').textContent=t.text;$('deleteDescription').textContent=count?'这条任务及其 '+count+' 个子任务将一并删除。确认后 15 秒内可撤销。':'确认后 15 秒内可撤销。';$('deleteOverlay').hidden=false;$('appMain').inert=true;document.body.style.overflow='hidden';$('deleteCancel').focus()}
$('deleteCancel').onclick=closeDelete;$('deleteOverlay').onclick=e=>{if(e.target===$('deleteOverlay'))closeDelete()};
$('deleteAccept').onclick=()=>{if(!pendingDelete)return;const ids=descendantIds(pendingDelete);if(mutate(()=>{data.tasks=data.tasks.filter(t=>!ids.has(t.id))},'任务已删除',{undo:true})){closeDelete();status('任务已删除，可在 15 秒内撤销。')}};
$('deleteOverlay').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();closeDelete()}else if(e.key==='Tab'){e.preventDefault();(document.activeElement===$('deleteCancel')?$('deleteAccept'):$('deleteCancel')).focus()}});
// Dragging changes sibling order only; overdue branches retain their priority.
let dragState=null;
function animatePositions(parent,change){
 const nodes=[...parent.children],before=new Map(nodes.map(node=>[node,node.getBoundingClientRect().top]));
 change();
 if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
 for(const node of nodes){const dy=before.get(node)-node.getBoundingClientRect().top;if(dy&&node.animate){node.moveAnimation?.cancel();node.moveAnimation=node.animate([{transform:'translateY('+dy+'px)'},{transform:'translateY(0)'}],{duration:210,easing:'cubic-bezier(.2,.75,.25,1)'});}}
}
function dragPriority(task){const ids=descendantIds(task.id);if(allTasks().some(t=>ids.has(t.id)&&isOverdue(t)))return 0;return 1}
function clearDrag(){if(!dragState)return;const state=dragState;dragState=null;state.block.classList.remove('is-dragging');state.block.removeAttribute('aria-grabbed');animatePositions(state.parent,()=>state.parent.insertBefore(state.block,state.next));}
function previewDrop(target,position){const state=dragState;if(!state)return;const next=position==='before'?target:target.nextSibling;if(next===state.block||state.block.nextSibling===next)return;animatePositions(state.parent,()=>state.parent.insertBefore(state.block,next));state.preview={targetId:target.taskId,position};}
function finishDrop(event){if(!dragState)return;event.preventDefault();event.stopPropagation();const state=dragState,preview=state.preview;clearDrag();if(preview)moveTask(state.id,preview.targetId,preview.position);}
function moveTask(sourceId,targetId,placement){const source=findTask(sourceId),target=findTask(targetId);if(!source||!target||source.parentId!==target.parentId){status('请在同一级任务之间拖动。',true);return}if(dragPriority(source)!==dragPriority(target)){status('逾期任务仍优先显示，请在同一优先分组内排序。');return}if(mutate(()=>{data=Model.reorder(data,sourceId,targetId,placement)},'顺序已保存'))$('drag-'+sourceId)?.focus()}
function dragHandle(row,task,groupIds,block){
 const handle=button('⠿',null,'drag-handle');handle.id='drag-'+task.id;handle.draggable=true;handle.title='拖动整组任务排序；也可使用上下方向键';handle.setAttribute('aria-label','调整 '+task.text+' 整组任务的顺序');
 handle.ondragstart=event=>{dragState={id:task.id,row,block,groupIds,parent:block.parentElement,next:block.nextSibling,preview:null};if(event.dataTransfer){event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',task.id);if(event.dataTransfer.setDragImage)event.dataTransfer.setDragImage(block,16,16)}const state=dragState;setTimeout(()=>{if(dragState===state){block.classList.add('is-dragging');block.setAttribute('aria-grabbed','true')}},0);event.stopPropagation()};handle.ondragend=clearDrag;
 const validTarget=()=>{const source=dragState&&findTask(dragState.id);return source&&source.id!==task.id&&groupIds.has(source.id)&&source.parentId===task.parentId&&dragState.block.closest('.card')===block.closest('.card')&&dragPriority(source)===dragPriority(task)};
 const placement=event=>{const bounds=block.getBoundingClientRect();return event.clientY<bounds.top+bounds.height/2?'before':'after'};
 block.ondragover=event=>{if(dragState?.block===block){event.preventDefault();event.stopPropagation();return}if(!validTarget())return;event.preventDefault();event.stopPropagation();if(event.dataTransfer)event.dataTransfer.dropEffect='move';previewDrop(block,placement(event))};
 block.ondrop=event=>{if(!dragState)return;if(dragState.block!==block&&!validTarget())return;finishDrop(event)};
 handle.onkeydown=event=>{if(!['ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const siblings=orderedTasks(allTasks().filter(t=>groupIds.has(t.id)&&t.parentId===task.parentId&&dragPriority(t)===dragPriority(task))),index=siblings.findIndex(t=>t.id===task.id),target=siblings[index+(event.key==='ArrowUp'?-1:1)];if(target)moveTask(task.id,target.id,event.key==='ArrowUp'?'before':'after')};return handle;
}
function taskRow(card,t){
 const row=document.createElement('div');row.className='task'+(t.state==='held'?' held-task':'')+(isOverdue(t)?' overdue-task':'');
 const check=document.createElement('input');check.type='checkbox';check.checked=t.state==='completed';check.setAttribute('aria-label',t.state==='completed'?'恢复待办':'标记完成');check.onchange=()=>{changeState(t,t.state==='completed'?'pending':'completed');render()};
 const label=document.createElement('span');label.className='label';label.textContent=t.text;label.tabIndex=0;label.setAttribute('role','button');label.setAttribute('aria-label','编辑：'+t.text);label.onclick=()=>openTaskEditor(t,'text');label.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();label.onclick()}};
 if(t.parentId){row.className+=' child-task';const remove=button('×',()=>deleteTask(t),'child-delete');remove.title='删除子任务';remove.setAttribute('aria-label','删除子任务：'+t.text);row.append(check,label,remove);card.append(row);const editor=taskEditor(t);if(editor)card.append(editor);return}
 const ddl=button(t.ddl===null?'长期':t.ddl.slice(5).replace('-','/')+(isOverdue(t)?' · 逾期':''),()=>editDDL(t),'ddl-tag'+(isOverdue(t)?' overdue':isActive(t)&&t.ddl===localDay()?' due-today':''));ddl.setAttribute('aria-label','修改截止日期：'+t.text);ddl.title=t.ddl===null?'长期任务':'截止 '+t.ddl;ddl.hidden=t.ddlMode==='inherit';
 const badge=document.createElement('span');badge.className='task-state '+t.state;badge.textContent=t.state==='held'?'搁置':t.state==='completed'?'完成':'';
 const actions=document.createElement('details');actions.className='actions task-menu';const more=document.createElement('summary');more.className='task-menu-toggle';more.textContent='⋯';more.title='任务操作';more.setAttribute('aria-label','操作：'+t.text);const panel=document.createElement('div');panel.className='task-menu-panel';actions.append(more,panel);const state=document.createElement('select');state.className='state-select';state.setAttribute('aria-label','变更事项状态：'+t.text);for(const [value,text]of [['pending','待办'],['completed','完成'],['held','搁置']])state.add(new Option(text,value));state.value=t.state;state.onchange=()=>{const value=state.value;changeState(t,value);render()};
 const delay=button('延期 +1天',()=>delayTask(t),'delay-button');delay.hidden=t.ddl===null||t.ddlMode==='inherit';delay.title='只延后 DDL，不改变状态';
 const stateLabel=document.createElement('label');stateLabel.className='menu-state';stateLabel.textContent='状态';stateLabel.append(state);panel.append(stateLabel,button('设置截止日期',()=>editDDL(t)),delay,button('删除',()=>deleteTask(t)));actions.addEventListener('toggle',()=>{if(actions.open)for(const other of document.querySelectorAll('.task-menu[open]'))if(other!==actions)other.open=false});
 const plus=button('+',()=>addSubtask(t),'task-add');plus.title='添加子任务';plus.setAttribute('aria-label','为 '+t.text+' 添加子任务');row.append(plus,check,label,ddl,badge,actions,dragHandle(row,t,card.groupIds,card));card.append(row);const editor=taskEditor(t);if(editor)card.append(editor);const sub=inlineEditor(t);if(sub)card.append(sub);
}
function taskTree(card,items){
 card.ondragover=event=>{if(dragState?.parent===card&&dragState.preview&&event.target===card){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move'}};
 card.ondrop=event=>{if(dragState?.parent===card&&dragState.preview&&event.target===card)finishDrop(event)};
 const ordered=orderedTasks(items),ids=new Set(items.map(t=>t.id)),nodes=new Map();
 for(const t of ordered){const node=document.createElement('div');node.className='tree-node';node.taskId=t.id;node.groupIds=ids;nodes.set(t.id,node);taskRow(node,t)}
 mountTree(card, ordered, nodes);
}
let historyTarget=null;
const expandedMonths=new Set();
function render(){
 const root=$('records');root.replaceChildren();const today=localDay(),selected=historyTarget||today,tasks=allTasks(),monthGroups=new Map();
 const archive=Model.archiveIndex(tasks),archiveDays=[...archive.done.keys(),...archive.held.keys()];
 const dates=[today,...[...new Set([...(selected<today?[selected]:[]),...archiveDays.filter(d=>d&&d!==today)])].sort().reverse()];
 for(const day of dates){
  const section=document.createElement('section');section.className='day-section';section.id='day-'+day;const heading=document.createElement('div');heading.className='day-heading';const title=document.createElement('h2');title.textContent=(day===today?'今天 · ':'')+day.replaceAll('-',' / ');const week=document.createElement('small');week.textContent=new Date(day+'T12:00:00').toLocaleDateString('zh-CN',{weekday:'long'});const line=document.createElement('span');line.className='line';heading.append(title,week,line);section.append(heading);const grid=document.createElement('div');grid.className='grid';
  for(const done of [false,true]){
   const items=done?(archive.done.get(day)||[]):day===today?archive.pending:(archive.held.get(day)||[]);
   const card=document.createElement('div');card.className='card'+(done?' done':'');const head=document.createElement('div');head.className='heading';const name=document.createElement('h3');name.textContent=done?'✓ DONE · 已完成':day===today?'○ ALL TODO · 全部待办与逾期':'◷ 搁置';const count=document.createElement('span');count.className='count';count.textContent=done?items.length:items.filter(t=>day===today?isActive(t):t.state==='held').length;head.append(name,count);card.append(head);
   if(!items.length){const empty=document.createElement('div');empty.className='empty';empty.textContent=done?'还没有完成事项':day===today?'暂无待办':'暂无搁置事项';card.append(empty)}
   taskTree(card,items);
   if(!done&&day===today){const held=archive.held.get(today)||[];if(held.length){const subheading=document.createElement('div');subheading.className='today-held-heading';subheading.textContent='◷ 今日搁置 · '+held.filter(t=>t.state==='held').length;card.append(subheading);taskTree(card,held)}}
   grid.append(card);
  }
  section.append(grid);
  const month=day.slice(0,7);
  if(month<today.slice(0,7)){
   let group=monthGroups.get(month);
   if(!group){
    const details=document.createElement('details');details.className='month-archive';details.id='month-'+month;details.open=expandedMonths.has(month);
    const summary=document.createElement('summary');const name=document.createElement('span');name.className='month-label';name.textContent=month.slice(0,4)+' 年 '+Number(month.slice(5))+' 月';
    const stats=document.createElement('span');stats.className='month-stats';const counts=archive.months.get(month)||{done:0,held:0},doneCount=counts.done,heldCount=counts.held;stats.textContent='完成 '+doneCount+' 个 · 搁置 '+heldCount+' 个';
    const hint=document.createElement('span');hint.className='month-toggle';hint.setAttribute('aria-hidden','true');summary.append(name,stats,hint);details.append(summary);
    const content=document.createElement('div');content.className='month-content';details.append(content);details.addEventListener('toggle',()=>{if(!details.isConnected)return;if(details.open)expandedMonths.add(month);else expandedMonths.delete(month)});
    group={details,content};monthGroups.set(month,group);root.append(details);
   }
   group.content.append(section);
  }else root.append(section);
 }
 const history=$('history');history.replaceChildren(new Option('查看历史',''));for(const d of dates)history.add(new Option(d,d));
}
function jumpToDate(day){historyTarget=day;const month=day.slice(0,7);if(month<localDay().slice(0,7))expandedMonths.add(month);render();$('day-'+day)?.scrollIntoView({behavior:'smooth',block:'start'})}
draftEditor($('newSubtasks'),newDrafts);$('newSubtaskButton').onclick=()=>addDraft($('newSubtasks'),newDrafts);$('todoForm').noValidate=true;
$('todoForm').onsubmit=e=>{e.preventDefault();const input=$('todoInput'),text=input.value.trim(),day=localDay(),ddl=$('deadlineMode').value==='long'?null:$('ddl').value;if(!validTaskText(text)||!validDrafts(newDrafts)){status('请填写事项和子任务内容（最多 2000 字）。',true);return}if(!validDate(day)||(ddl!==null&&!validDate(ddl))){status('请选择有效 DDL，或设为长期。',true);return}if(mutate(()=>{const parent=makeTask(text,day,ddl);data.tasks.push(parent);appendDrafts(day,parent,newDrafts)},'事项与子任务已添加')){input.value='';newDrafts.length=0;draftEditor($('newSubtasks'),newDrafts);$('deadlineMode').value='date';$('ddl').value=localDay();syncDeadlineMode()}input.focus()};
// The debug clock is session-only. It changes date-based behavior, never the system clock.
function setDebugToday(value){const before=localDay();debugToday=value;lastToday=localDay();historyTarget=null;closeAction();clearUndo();if($('ddl').value===before)$('ddl').value=localDay();updateClockUI();render()}
function updateClockUI(){$('todayDisplay').textContent=(debugToday?'调试今天 · ':'今天 · ')+localDay();$('debugDate').value=localDay();$('debugActive').hidden=!debugToday}
$('debugToggle').onclick=()=>{$('debugPanel').hidden=!$('debugPanel').hidden};
$('debugApply').onclick=()=>{if(!validDate($('debugDate').value)){status('请选择有效调试日期。',true);return}setDebugToday($('debugDate').value);status('已临时设置今天；刷新会恢复真实日期。')};
$('debugReset').onclick=()=>setDebugToday(null);

$('history').onchange=()=>{if($('history').value)jumpToDate($('history').value)};
updateClockUI();
$('export').onclick=()=>{const blob=new Blob([JSON.stringify(Model.backup(data),null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='日日·ToDo-backup-'+localDay()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('已发起备份下载。')};
$('import').onclick=()=>$('file').click();
$('file').onchange=async event=>{
 const file=event.target.files[0];if(!file)return;
 try{
  if(file.size>MAX_BACKUP_BYTES)throw Error('文件不能超过 10 MB');
  const incoming=Model.parse(await file.text());const preview=Model.merge(data,incoming).stats;
  askInline('合并预览：新增 '+preview.added+' 条，重复 '+preview.identical+' 条，冲突 '+preview.conflicts+' 条（保留当前记录）。现有记录不会被替代。',()=>{
   let result;
   const success=mutate(()=>{result=Model.merge(data,incoming);data=result.model},'备份已合并');
   if(success)status('合并完成：新增 '+result.stats.added+' 条，跳过重复 '+result.stats.identical+' 条，保留本地冲突 '+result.stats.conflicts+' 条。');
  },'合并导入');
 }catch(err){status('导入失败：'+err.message,true)}finally{event.target.value=''}
};
function refreshDay(){const today=localDay();if(today!==lastToday){if($('ddl').value===lastToday)$('ddl').value=today;lastToday=today;updateClockUI();render()}}
window.addEventListener('storage',event=>{if(event.key===KEY){try{data=store.load();storageOK=true;clearUndo();closeAction();taskEdits.clear();inlineDrafts.clear();refreshDay();render();status('已同步其他窗口的修改。')}catch(err){storageOK=false;status('其他窗口的数据无效：'+err.message,true)}}});
document.addEventListener('click',event=>{if(!event.target.closest('.task-menu'))for(const menu of document.querySelectorAll('.task-menu[open]'))menu.open=false});document.addEventListener('keydown',event=>{if(event.key==='Escape')for(const menu of document.querySelectorAll('.task-menu[open]'))menu.open=false});
window.addEventListener('focus',refreshDay);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshDay()});setInterval(refreshDay,30000);
if(storageOK)status('自动保存已就绪 · 数据格式 v2');render();
})();
