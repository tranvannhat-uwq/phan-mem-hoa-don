import {state} from '../state.js';
import {dbAdminSystemStatus,reportApplicationEgress} from '../services/supabase.js?v=20261029-supplier-picker-v1';
import {STATUS_UPDATE_MS} from '../domain/application-egress.js';
let owner='',data=null,lastAttempt=0,loading=false,failed=false,generation=0,timer=null;
const actor=()=>state.currentUser?.role==='admin'?String(state.currentUser.authUserId||state.currentUser.id):'';
const stamp=value=>value?new Date(value).toLocaleString('vi-VN',{timeZone:'Asia/Bangkok'}):'Chưa có số liệu';
const bytes=value=>{if(value==null)return'Chưa có số liệu';const n=Number(value);if(!Number.isFinite(n))return'—';return n>=1e9?`${(n/1e9).toLocaleString('vi-VN',{maximumFractionDigits:2})} GB`:`${(n/1e6).toLocaleString('vi-VN',{maximumFractionDigits:2})} MB`;};
export function resetSystemStatus(){generation++;owner='';data=null;lastAttempt=0;loading=false;failed=false;if(timer!==null)clearInterval(timer);timer=null;const p=document.getElementById('system-status-panel');if(p){p.replaceChildren();delete p.dataset.ready;}}
export function renderSystemStatus(){
 const p=document.getElementById('system-status-panel');if(!p)return;
 if(owner!==actor()){resetSystemStatus();owner=actor();}
 if(!owner||!p.classList.contains('active'))return;
 if(!p.dataset.ready){
  p.dataset.ready='true';p.innerHTML=`<div class="system-status-header"><div><h2>Tình trạng hệ thống</h2><p>Chỉ hiển thị số tổng mới nhất · tự cập nhật 2 giờ/lần.</p></div><button type="button" class="btn btn-primary" id="system-status-refresh">Cập nhật ngay</button></div>
   <p class="system-status-error" id="system-status-error" role="alert" hidden></p>
   <div class="system-status-cards">
    <article><span>Dung lượng database</span><strong id="system-database-bytes">—</strong><small id="system-database-time">Đang lấy số liệu…</small></article>
    <article><span>Kết nối database</span><strong id="system-database-connections">—</strong><small id="system-database-locks">Đang lấy số liệu…</small></article>
    <article><span>Egress ứng dụng · ước tính</span><strong id="system-egress-bytes">—</strong><small id="system-egress-time">Đang lấy số liệu…</small></article>
   </div><div class="system-status-footer"><p id="system-status-state" role="status">Đang tải trạng thái…</p><p id="system-egress-since"></p><p>Egress tổng hợp phản hồi HTTP từ các phiên ứng dụng đã gửi số liệu, cập nhật theo đợt 2 giờ. Không phải tổng Usage/hạn mức Supabase; không bao gồm lưu lượng WebSocket và các nguồn tải ngoài ứng dụng.</p><p>CPU/RAM chưa được thu thập trong phiên bản theo dõi cơ bản này.</p></div>`;
  p.querySelector('#system-status-refresh').addEventListener('click',()=>void load(true));
  timer=setInterval(()=>{if(!document.hidden&&p.classList.contains('active')&&actor())void load(false);},STATUS_UPDATE_MS);
 }
 draw();if(!loading&&Date.now()-lastAttempt>=STATUS_UPDATE_MS)void load(false);
}
function draw(){const p=document.getElementById('system-status-panel');if(!p?.dataset.ready)return;p.querySelector('#system-status-refresh').disabled=loading;p.querySelector('#system-status-refresh').textContent=loading?'Đang cập nhật…':'Cập nhật ngay';if(!data){p.querySelector('#system-status-state').textContent=failed?'Chưa tải được số liệu.':'Đang tải trạng thái…';return;}
 p.querySelector('#system-database-bytes').textContent=bytes(data.databaseBytes);
 p.querySelector('#system-database-time').textContent=`Ghi nhận: ${stamp(data.sampledAt)}`;
 p.querySelector('#system-database-connections').textContent=`${Number(data.connections)||0} / ${Number(data.maxConnections)||0}`;
 p.querySelector('#system-database-locks').textContent=Number(data.waitingLocks)>0?`${Number(data.waitingLocks)} kết nối đang chờ khóa`:'Không ghi nhận kết nối chờ khóa';
 p.querySelector('#system-egress-bytes').textContent=bytes(data.egressBytes);
 p.querySelector('#system-egress-time').textContent=`Gửi số liệu gần nhất: ${stamp(data.egressReportedAt)}`;
 p.querySelector('#system-egress-since').textContent=`Cộng dồn từ khi bật theo dõi: ${stamp(data.egressSince)}. Cập nhật ngay sẽ gửi thêm số liệu của phiên Admin hiện tại.`;
 const warning=Number(data.waitingLocks)>0||(Number(data.maxConnections)>0&&Number(data.connections)/Number(data.maxConnections)>=.85);
 p.querySelector('#system-status-state').textContent=failed?'Chưa cập nhật được; đang hiển thị số liệu đã lưu.':warning?'Cần kiểm tra lượng kết nối hoặc kết nối chờ khóa.':'Kết nối database hoạt động.';
 p.querySelector('#system-status-state').dataset.warning=String(warning||failed);
}
async function load(force){if(loading||!actor())return;const current=actor(),version=++generation;lastAttempt=Date.now();loading=true;failed=false;draw();const p=document.getElementById('system-status-panel');const box=p.querySelector('#system-status-error');box.hidden=true;
 try{let reportFailed=false;if(force){try{await reportApplicationEgress();}catch{reportFailed=true;}}
  const result=await dbAdminSystemStatus(force);if(version!==generation||current!==actor())return;
  data=result;if(reportFailed){box.textContent='Chưa gửi được egress của phiên này. Số egress đang hiển thị là số tổng đã nhận trước đó.';box.hidden=false;}
 }catch(error){if(version===generation&&current===actor()){failed=true;box.textContent=error.message;box.hidden=false;}}
 finally{if(version===generation&&current===actor()){loading=false;draw();}}
}
