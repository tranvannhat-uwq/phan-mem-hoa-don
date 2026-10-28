// Synthetic UI fixture. It never connects to Supabase or modifies business data.
const names=['Công ty Bao Bì Nam Hải','Công ty Sơn Ánh Dương','Vật tư Đại Việt','Công ty Nhựa Phú Thành','Đối tác Bình Minh'];
const all=Array.from({length:45},(_,i)=>({id:'sample-'+i,code:'NCC'+String(i+1).padStart(3,'0'),name:names[i%5]+' '+(i+1),opening:i%4===0?-250000:1000000,debit:10000000-i*100000,credit:3000000+i*50000})).map(r=>({...r,closing:r.opening+r.debit-r.credit}));
const fold=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/g,'d').toLowerCase();
export async function dbSupplierDebtReport(f,offset=0,limit=20){
  const rows=all.filter(r=>fold(r.code+' '+r.name).includes(fold(f.query))&&(!f.min||r.closing>=Number(f.min))&&(!f.max||r.closing<=Number(f.max))&&(f.status!=='advance'||r.closing<0)&&(f.status!=='settled'||r.closing===0)).sort((a,b)=>b.closing-a.closing);
  const totals=rows.reduce((t,r)=>{for(const k of ['opening','debit','credit','closing'])t[k]+=r[k];return t;},{opening:0,debit:0,credit:0,closing:0});
  return{from:f.from,to:f.to,generatedAt:'2026-10-28T07:00:00Z',rows:rows.slice(offset,offset+limit),total:rows.length,totals,fingerprint:JSON.stringify(rows),cutoff:'2026-08-31T17:00:00Z'};
}
export async function dbSupplierDebtHistory(){return{rows:[],total:0};}
export async function dbImportSupplierDebtReport(){throw new Error('Không nhập dữ liệu trong trang kiểm thử.');}
