import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../js/components/data-retention.js',import.meta.url),'utf8')
  .replace(/^import .+;\r?\n/gm,'').replace(/^export /gm,'');

function harness(prepare=async()=>{throw new Error('Synthetic server rejection');},hold=async()=>({added:1,preview:{cutoff:'2026-09-01T00:00:00+07:00',counts:{},blockers:[],review_pending:0,review_held:1}})) {
  const nodes=new Map(),calls=[],downloads=[],previews=[],holds=[];
  let focused='',generated=0;
  function node(id) {
    if(!nodes.has(id))nodes.set(id,{value:'',textContent:'',hidden:false,disabled:false,checked:true,
      attributes:{},handlers:{},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},
      focus(){focused=id;},addEventListener(k,fn){this.handlers[k]=fn;},replaceChildren(){},append(){}});
    return nodes.get(id);
  }
  const context=vm.createContext({state:{currentUser:{role:'admin'}},
    document:{getElementById:node,createElement:tag=>tag==='a'?{click(){downloads.push(this.download);}}:{textContent:''}},
    dbPrepareMonthlyRetention:async(...args)=>{calls.push(args);return prepare(...args);},
    dbPreviewMonthlyRetention:async includeArchive=>{previews.push(includeArchive);return {cutoff:'2026-09-01',counts:{},blockers:[]};},
    dbHoldRetentionWarnings:async includeArchive=>{holds.push(includeArchive);return hold(includeArchive);},
    getRetentionSessionScope:()=> 'synthetic-project|synthetic-user',
    dbReleaseRetentionBackup:async()=>true,
    dbExecuteMonthlyRetention:async()=>{throw new Error('Deletion must never run in backup tests');},
    encryptRetentionBackup:async()=> 'synthetic encrypted payload',
    retentionConfirmation:()=> 'XOA TRUOC 01/09/2026',
    crypto:{randomUUID:()=> `synthetic-request-${++generated}`},Blob,URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL(){}},
    setTimeout(){},console});
  vm.runInContext(source,context);vm.runInContext('setupRetentionSettings()',context);
  return {node:id=>node('retention-'+id),calls,downloads,previews,holds,get focused(){return focused;},
    click:()=>node('retention-prepare').handlers.click()};
}

test('short passwords show an adjacent error and never request a backup',async()=>{
  const h=harness();h.node('password').value=h.node('password-again').value='1234567890';
  await h.click();
  assert.equal(h.calls.length,0);assert.equal(h.focused,'retention-password');
  assert.equal(h.node('password').attributes['aria-invalid'],'true');
  assert.match(h.node('prepare-status').textContent,/ít nhất 12 ký tự/);
  assert.equal(h.node('prepare-status').attributes.role,'alert');
  assert.equal(h.node('prepare-status').hidden,false);
  assert.equal(h.node('execute').disabled,true);
  h.node('password').handlers.input();assert.equal(h.node('password').attributes['aria-invalid'],undefined);
});

test('mismatched passwords focus confirmation and never request a backup',async()=>{
  const h=harness();h.node('password').value='Synthetic password 1';h.node('password-again').value='Synthetic password 2';
  await h.click();assert.equal(h.calls.length,0);assert.equal(h.focused,'retention-password-again');
  assert.match(h.node('prepare-status').textContent,/chưa giống nhau/);
});

test('database blockers appear beside the button and leave deletion locked',async()=>{
  const blocker='Chưa thể dọn: Hàng cấp thuộc kỳ xóa thiếu khách hoặc sai số lượng/trả hàng; cần đối soát trước.';
  const h=harness(async()=>{throw new Error(blocker);});
  h.node('password').value=h.node('password-again').value='Synthetic password';await h.click();
  assert.equal(h.calls.length,1);assert.equal(h.node('prepare-status').textContent,blocker);
  assert.equal(h.node('status').textContent,blocker);assert.equal(h.downloads.length,0);
  assert.equal(h.node('execute').disabled,true);assert.equal(h.node('prepare').disabled,false);
});

test('pending preparation displays progress and blocks duplicate clicks',async()=>{
  let reject;const pending=new Promise((_,fail)=>{reject=fail;});const h=harness(()=>pending);
  h.node('password').value=h.node('password-again').value='Synthetic password';const first=h.click();
  assert.equal(h.node('prepare').disabled,true);assert.equal(h.node('prepare').attributes['aria-busy'],'true');
  assert.match(h.node('prepare').textContent,/Đang tạo/);await h.click();assert.equal(h.calls.length,1);
  reject(new Error('Synthetic network failure'));await first;
  assert.equal(h.node('prepare').attributes['aria-busy'],'false');assert.equal(h.node('prepare').disabled,false);
  assert.match(h.node('prepare-status').textContent,/network failure/);
});

test('successful preparation downloads the file but still requires verification before deletion',async()=>{
  const h=harness(async()=>({job_id:'synthetic-job',backup_text:'{}',backup_sha256:'synthetic-hash',
    expires_at:'2099-01-01',preview:{cutoff:'2026-09-01T00:00:00+07:00',counts:{},blockers:[]}}));
  h.node('password').value=h.node('password-again').value='Synthetic password';await h.click();
  assert.deepEqual(h.downloads,['SoViet-phuc-hoi-synthetic-job.encrypted.json']);
  assert.equal(h.calls[0][1],false,'The file must exclude the legacy archive');
  assert.match(h.node('prepare-status').textContent,/Đã tạo file mã hóa/);
  assert.equal(h.node('file').disabled,false);assert.equal(h.node('execute').disabled,true);
  assert.equal(h.node('password').value,'');assert.equal(h.node('password-again').value,'');
});

test('skip refreshes the server plan and invalidates verification without executing deletion',async()=>{
  const h=harness();await h.node('hold').handlers.click();
  assert.deepEqual(h.holds,[false],'The review plan must use the same archive scope as the file');
  assert.equal(h.node('hold').hidden,true);assert.equal(h.node('held-note').hidden,false);
  assert.match(h.node('held-note').textContent,/Đang giữ 1 chứng từ/);
  assert.match(h.node('prepare-status').textContent,/Chưa xóa dữ liệu/);
  assert.equal(h.node('execute').disabled,true);assert.equal(h.node('file').disabled,true);
});

test('preview excludes the legacy archive and no longer offers the archive checkbox',async()=>{
  const h=harness();await h.node('preview').handlers.click();
  assert.deepEqual(h.previews,[false]);
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id="retention-archive"/);
});

test('retry after a lost preparation response keeps its request key and leaves deletion locked',async()=>{
  const h=harness(async()=>{throw new TypeError('Failed to fetch');});
  h.node('password').value=h.node('password-again').value='Synthetic password';
  await h.click();await h.click();
  assert.equal(h.calls.length,2);assert.equal(h.calls[0][0],h.calls[1][0]);
  assert.match(h.node('prepare-status').textContent,/tiếp tục các phần/);
  assert.equal(h.node('execute').disabled,true);
  h.node('restart').handlers.click();await h.click();
  assert.notEqual(h.calls[2][0],h.calls[0][0]);
});

test('skip keeps unrelated red blockers visible and cannot unlock deletion',async()=>{
  const h=harness(undefined,async()=>({added:1,preview:{cutoff:'2026-09-01',counts:{},blockers:['Có khách lệch công nợ'],review_pending:0,review_held:1}}));
  await h.node('hold').handlers.click();assert.equal(h.node('execute').disabled,true);
  assert.match(h.node('prepare-status').textContent,/màu đỏ vẫn cần xử lý/);
});
