import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptRetentionBackup,decryptRetentionBackup,sha256Hex } from '../js/services/retention-backup.js';
import { retentionCutoffDate,retentionConfirmation,clearRetainedHistoryCaches,openingDebtRow,independentReturnTotal } from '../js/domain/data-retention.js';
import { getCustomerTotalPayments } from '../js/domain/customer-debt.js';

test('two calendar months use Vietnam time including year rollover and midnight',()=>{
  assert.equal(retentionCutoffDate(new Date('2026-10-31T16:59:59Z')),'2026-09-01');
  assert.equal(retentionCutoffDate(new Date('2026-10-31T17:00:00Z')),'2026-10-01');
  assert.equal(retentionCutoffDate(new Date('2026-01-01T00:00:00Z')),'2025-12-01');
  assert.equal(retentionConfirmation('2026-08-31T17:00:00Z'),'XOA TRUOC 01/09/2026');
});
test('purge all scoped customer and financial caches while preserving login and catalog',()=>{
  const data=new Map([['billing_system_customers__user1','private'],['billing_system_orders','private'],
    ['billing_system_cashbook_opening','private'],['sb-project-auth-token','login'],['billing_system_products','catalog']]);
  const storage={get length(){return data.size;},key(i){return [...data.keys()][i];},removeItem(k){data.delete(k);}};
  clearRetainedHistoryCaches(storage);
  assert.deepEqual([...data.keys()],['sb-project-auth-token','billing_system_products']);
});
test('virtual debt opening carries collected totals without creating a new receipt',()=>{
  const opening=openingDebtRow({customer_id:'customer',cutoff:'2026-09-01',debt_opening:-100,payment_carry:500});
  assert.equal(opening.debt_change,0); assert.equal(opening.balance_after,-100);
  assert.equal(getCustomerTotalPayments([opening,{id:'p',type:'payment',amount:25,debtChange:-25}]),525);
});
test('independent receiving prices follow rounded server arithmetic',()=>{
  assert.equal(independentReturnTotal([{quantity:1.25,unitPrice:100,deductionPercent:10}]),113);
  assert.equal(independentReturnTotal([{quantity:0.29,unitPrice:100,deductionPercent:50}]),15);
  for(const item of [{quantity:-1,unitPrice:100},{quantity:1,unitPrice:Infinity},{quantity:1.00001,unitPrice:100}]) {
    assert.throws(()=>independentReturnTotal([item]));
  }
});
test('encrypted backup roundtrip verifies file, password, job, digest and corruption',async()=>{
  const payload={format:'soviet-retention-recovery-v1',job_id:'synthetic-job',tables:{customers:[{id:'customer',debt:-50}]},columns:{customers:['id','debt']}};
  const backup_text=JSON.stringify(payload); const backup_sha256=await sha256Hex(backup_text);
  const encrypted=await encryptRetentionBackup({job_id:payload.job_id,backup_text,backup_sha256},'Synthetic strong password');
  assert.ok(!encrypted.includes('customer'));
  assert.deepEqual((await decryptRetentionBackup(encrypted,'Synthetic strong password',{jobId:payload.job_id,sha256:backup_sha256})).payload,payload);
  await assert.rejects(decryptRetentionBackup(encrypted,'Incorrect password'),/Mật khẩu/);
  await assert.rejects(decryptRetentionBackup(encrypted,'Synthetic strong password',{jobId:'other'}),/không thuộc/);
  await assert.rejects(encryptRetentionBackup({backup_text,backup_sha256:'0'.repeat(64)},'Synthetic strong password'),/không khớp/);
  const corrupt=JSON.parse(encrypted); corrupt.ciphertext=(corrupt.ciphertext[0]==='A'?'B':'A')+corrupt.ciphertext.slice(1);
  await assert.rejects(decryptRetentionBackup(JSON.stringify(corrupt),'Synthetic strong password'),/thay đổi/);
});
