import test from 'node:test';
import assert from 'node:assert/strict';
import {createApplicationEgressReporter,STATUS_UPDATE_MS} from '../js/domain/application-egress.js';
import {readFile} from 'node:fs/promises';

test('reporting waits two hours, sends only aggregates and coalesces parallel manual calls',async()=>{
 let interval,callback,posts=0,finish;const timer=[];
 const r=createApplicationEgressReporter({actor:()=> 'actor',snapshot:async()=>({totals:{estimatedResponseBytes:100,requests:2,truncatedResponses:1},routes:[{secret:'not sent'}]}),
 rpc:async(name,args)=>{posts++;assert.equal(name,'rpc_report_application_egress');assert.deepEqual(Object.keys(args.p_report).sort(),['actorId','bytes','day','requests','sessionId','truncated']);await new Promise(resolve=>{finish=resolve;});},
 uuid:()=> 'session',schedule:(fn,ms)=>{callback=fn;interval=ms;return timer;},cancel:()=>{}});
 r.start();r.start();assert.equal(interval,7200000);assert.equal(posts,0);
 const a=r.flush(),b=r.flush();await new Promise(resolve=>setTimeout(resolve,0));finish();await Promise.all([a,b]);assert.equal(posts,1);r.stop();
});
test('failed/uncertain uploads retry cumulative counts; meter resets and account changes create fresh scopes',async()=>{
 let owner='a',n=10,fail=true,id=0;const calls=[];
 const r=createApplicationEgressReporter({actor:()=>owner,uuid:()=>String(++id),snapshot:async()=>({totals:{estimatedResponseBytes:n,requests:n,truncatedResponses:0}}),rpc:async(name,args)=>{calls.push(args.p_report);if(fail)throw Error('timeout');}});
 await assert.rejects(r.flush(),/timeout/);fail=false;n=20;await r.flush();assert.equal(calls[1].bytes,20);assert.equal(calls[0].sessionId,calls[1].sessionId);
 n=5;await r.flush();assert.equal(calls[2].bytes,5);assert.notEqual(calls[2].sessionId,calls[1].sessionId);
 owner='b';r.reset();await r.flush();assert.equal(calls[3].actorId,'b');assert.notEqual(calls[3].sessionId,calls[2].sessionId);
});
test('a snapshot finishing after logout cannot be uploaded under the next login',async()=>{
 let owner='a',finish,posts=0;const r=createApplicationEgressReporter({actor:()=>owner,uuid:()=> 's',snapshot:()=>new Promise(resolve=>{finish=resolve;}),rpc:async()=>{posts++;}});
 const pending=r.flush();owner='b';r.reset();finish({totals:{requests:1,estimatedResponseBytes:20}});assert.equal(await pending,false);assert.equal(posts,0);
});
test('system page is Admin-only, latest-only and contains no history/chart polling',async()=>{
 const [ui,users,main,sql]=await Promise.all(['js/components/system-status.js','js/components/users.js','js/main.js','migrations/0132_admin_system_status.sql'].map(p=>readFile(new URL('../'+p,import.meta.url),'utf8')));
 assert.match(ui,/2 giờ\/lần/);assert.match(ui,/Cập nhật ngay/);assert.doesNotMatch(ui,/new Chart|<table|localStorage/);
 assert.match(users,/target==='system-status-panel'.*role==='admin'/);assert.match(main,/panelId==='system-status-panel'.*role!=='admin'/);
 assert.match(sql,/'0 \*\/2 \* \* \*'/);assert.match(sql,/actor.role<>'admin'/);assert.match(sql,/private\.app_egress_sessions/);
 assert.equal(STATUS_UPDATE_MS,7200000);
});
