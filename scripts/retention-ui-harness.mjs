// Local test harness. All data and RPC responses on this page are synthetic.
// No credentials, Supabase SDK or network database access is loaded.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {buildRetentionUpgrade} from './build-retention-upgrade.mjs';
const root=new URL('../',import.meta.url);
const html=await readFile(new URL('index.html',root),'utf8');
const escape=text=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const wizard=html.slice(html.indexOf('<div id="monthly-retention-section"'),html.indexOf('<div id="maintenance-mode-section"'));
const returns=html.slice(html.indexOf('<div id="independent-returns-section"'),html.indexOf('<div class="glass-panel">',html.indexOf('<div id="independent-returns-section"')));
const mockState=`export const state={currentUser:{id:'synthetic-admin',role:'admin'},retentionEpoch:0,
  customers:[{id:'synthetic-customer',code:'KH-TEST',name:'Khách thử nghiệm'}],
  companies:[{id:'ABS_NORTH',name:'Công ty thử nghiệm'}],
  products:[{id:'synthetic-product',code:'TEST-01',name:'Sản phẩm thử nghiệm',packageType:'Thùng',isActive:true,isLegacy:false}]};`;
const mockServices=`import {state} from '../state.js';
import {independentReturnTotal,retentionCutoffDate} from '../domain/data-retention.js';
import {sha256Hex} from './retention-backup.js';
const preview=()=>({cutoff:retentionCutoffDate()+'T00:00:00+07:00',counts:{orders:100,cashbook:50,returns:3,ledger:180,legacy_archive:900},blockers:[],can_prepare:true});
let prepared;const records=[];const requests=new Map();
export function getRetentionSessionScope(){return 'synthetic-project|'+state.currentUser.id;}
export async function dbPreviewMonthlyRetention(){return preview();}
export async function dbPrepareMonthlyRetention(key){
 const payload={format:'soviet-retention-recovery-v1',job_id:key,tables:{customers:[{id:'synthetic-customer',debt:123}]},columns:{customers:['id','debt']}};
 const backup_text=JSON.stringify(payload);prepared={job_id:key,preview:preview(),backup_text,backup_sha256:await sha256Hex(backup_text),expires_at:new Date(Date.now()+1800000).toISOString()};return prepared;}
export async function dbExecuteMonthlyRetention(){return {verified:true,success:true};}
export async function dbRetentionJob(){return {state:'prepared'};}
export async function dbListIndependentReturns(){return {rows:records,total:records.length};}
export async function dbRecordIndependentReturn(input){if(requests.has(input.idempotencyKey))return requests.get(input.idempotencyKey);
 const total=independentReturnTotal(input.items);const ret={id:'TR-TEST-'+(records.length+1),customerId:input.customerId,customerName:'Khách thử nghiệm',createdAt:new Date().toISOString(),status:'completed',totalRefund:total,sourceKind:'independent',items:[]};
 const result={return_id:ret.id,new_debt:-total,return:ret,customer_name:ret.customerName};records.unshift(result);requests.set(input.idempotencyKey,result);return result;}
export async function dbCancelSalesReturn(id){records.find(r=>r.return_id===id).return.status='cancelled';return {success:true};}
export async function dbRefreshCustomerFinancialState(){return {};}`;
const page=`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>Kiểm thử dọn dữ liệu — dữ liệu giả</title>
<body style="padding:24px;overflow:auto"><main style="max-width:1000px;margin:auto"><h1>Kiểm thử giao diện — toàn bộ dữ liệu giả</h1><p>Trang này không kết nối Supabase.</p>
<nav class="retention-actions" style="margin:1rem 0"><button id="tab-retention" class="btn btn-secondary">Dọn dữ liệu</button><button id="tab-returns" class="btn btn-secondary">Trả hàng</button><button id="tab-accounting" class="btn btn-secondary">Xem bằng quyền kế toán</button></nav>
<section id="wizard" class="glass-panel" style="max-width:680px">${wizard}</section><section id="receiving" hidden>${returns}</section><p id="test-toast" role="status"></p>
<script type="module">
import{state}from'/js/state.js';import{setupRetentionSettings,renderRetentionSettings}from'/js/components/data-retention.js';
import{setupIndependentReturns,renderIndependentReturns}from'/js/components/independent-returns.js';
setupRetentionSettings();setupIndependentReturns();renderRetentionSettings();
document.querySelector('#tab-retention').onclick=()=>{document.querySelector('#wizard').hidden=false;document.querySelector('#receiving').hidden=true;renderRetentionSettings();};
document.querySelector('#tab-returns').onclick=()=>{document.querySelector('#wizard').hidden=true;document.querySelector('#receiving').hidden=false;renderIndependentReturns();};
document.querySelector('#tab-accounting').onclick=()=>{state.currentUser.role='accounting';renderRetentionSettings();document.querySelector('#test-toast').textContent='Quyền kế toán: không được mở chức năng xóa.';};
</script></main></body></html>`;
createServer(async(req,res)=>{
  try{
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    let source;let type='text/javascript';
    if(path==='/'){source=page;type='text/html';}
    else if(path==='/database-check'||path==='/database-install'){
      source=`<!doctype html><html><meta charset="utf-8"><title>Retention SQL review</title><h1>${path==='/database-check'?'Rollback compatibility check':'Additive installation — no purge'}</h1><textarea aria-label="Script SQL để kiểm tra" style="width:95vw;height:85vh" readonly>${escape(await buildRetentionUpgrade({dryRun:path==='/database-check'}))}</textarea></html>`;type='text/html';
    }else if(path==='/js/state.js')source=mockState;
    else if(path==='/js/services/supabase.js')source=mockServices;
    else if(path==='/js/utils.js')source=`export const formatCurrency=n=>Number(n).toLocaleString('vi-VN')+' ₫';export const showToast=t=>{document.querySelector('#test-toast').textContent=t;};`;
    else if(path==='/js/components/history.js')source=`export function printReturnSlip(ret){document.querySelector('#test-toast').textContent='In phiếu thử '+ret.id;}`;
    else if(path==='/style.css'){source=await readFile(new URL('style.css',root),'utf8');type='text/css';}
    else if(/^\/js\/(components\/(data-retention|independent-returns)|domain\/data-retention|services\/retention-backup)\.js$/.test(path))source=await readFile(new URL(path.slice(1),root),'utf8');
    else{res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':type+';charset=utf-8','Cache-Control':'no-store'});res.end(source);
  }catch(e){res.writeHead(500).end(e.message);}
}).listen(5181,'127.0.0.1',()=>console.log('Synthetic retention UI: http://127.0.0.1:5181/'));
