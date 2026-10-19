import { state } from '../state.js';
import { isCloudActive, supabaseClient } from './supabase.js?v=20261019-debt-adjustment-undo-v1';

let generation = 0;
let session = '';
const cache = new Map();
const scope = () => state.currentUser && ['admin','accounting'].includes(state.currentUser.role)
  ? `${state.currentUser.authUserId || state.currentUser.id}:${state.currentUser.role}` : '';
function requireSession() {
  const next=scope();
  if(next!==session){session=next;generation++;cache.clear();}
  if(!next)throw new Error('Cần đăng nhập bằng Admin hoặc Kế toán để sử dụng BOM.');
  if(!isCloudActive||!supabaseClient)throw new Error('Cần kết nối Cloud để sử dụng BOM.');
  return {actor:next,version:generation};
}
async function call(name,args) {
  const {actor,version}=requireSession();
  const {data,error}=await supabaseClient.rpc(name,args);
  if(version!==generation||actor!==scope())throw new Error('Phiên làm việc đã thay đổi.');
  if(error){
    if(error.code==='42702')throw new Error('Cloud cần chạy migration 0094 trước khi sửa vật tư hoặc đổi đơn vị.');
    if(['PGRST202','42883'].includes(error.code))throw new Error('Cloud chưa cập nhật BOM 0092.');
    const failure=new Error(error.message||'Không thể thực hiện thao tác BOM.');
    failure.definitive=/^(?:PGRST\d+|[A-Z0-9]{5})$/.test(error.code||'');
    throw failure;
  }
  return data;
}
export const bomGateway={
  clear(){generation++;cache.clear();session='';},
  async read(filters={}, {force=false}={}){
    requireSession();
    const key=JSON.stringify(filters);
    const hit=cache.get(key);
    if(!force&&hit&&Date.now()-hit.at<60000)return hit.data;
    const data=await call('rpc_bom_window',{p_filters:filters});
    if(!Array.isArray(data?.rows)||data.rows.length>Number(filters.limit??15))throw new Error('Cloud trả dữ liệu BOM không hợp lệ.');
    if(cache.size>=8)cache.delete(cache.keys().next().value);
    cache.set(key,{at:Date.now(),data});
    return data;
  },
  async saveItem(input){const data=await call('rpc_bom_save_item',{p_input:input});cache.clear();return data;},
  async postItem(input){const data=await call('rpc_bom_post_item',{p_input:input});cache.clear();return data;},
  async saveDraft(input){const data=await call('rpc_bom_save_draft',{p_input:input});cache.clear();return data;},
  async publish(id){const data=await call('rpc_bom_publish',{p_version_id:id});cache.clear();return data;},
  async run(input){const data=await call('rpc_bom_run',{p_input:input});cache.clear();return data;}
};
