import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {canViewDashboard} from '../js/domain/dashboard-access.js';
import {buildRetentionDatabase,asActor,scalar,adminId,accountingId,saleId} from './helpers/retention-db.mjs';
test('dashboard checkbox affects accountants while keeping existing Admin and sales navigation',()=>{
 assert.equal(canViewDashboard({role:'admin',canViewDashboard:false}),true);
 assert.equal(canViewDashboard({role:'accounting'}),true);
 assert.equal(canViewDashboard({role:'accounting',canViewDashboard:false}),false);
 assert.equal(canViewDashboard({role:'accounting',can_view_dashboard:false}),false);
 assert.equal(canViewDashboard({role:'accounting',canViewDashboard:true}),true);
 assert.equal(canViewDashboard({role:'sale',canViewDashboard:true}),false);
 assert.equal(canViewDashboard(null),false);
});
test('saving an account sends the unchecked permission without changing the role or other profile fields',async()=>{
 const source=await readFile(new URL('../js/services/supabase.js',import.meta.url),'utf8');
 const save=source.slice(source.indexOf('export async function dbSaveUser('),source.indexOf('export async function dbDeleteUser(')).replace('export ','');
 let saved;const context=vm.createContext({state:{users:[{id:'u-accounting'}]},isCloudActive:true,tableUsersName:'profiles',
  authRegisterOrUpdateUser:async()=>true,supabaseClient:{from:()=>({upsert:async row=>{saved=row;return{error:null};}})},showToast(){},console});
 vm.runInContext(save,context);
 assert.equal(await context.dbSaveUser({id:'u-accounting',authUserId:'auth-accounting',username:'accounting@test.invalid',displayName:'Accountant',role:'accounting',canViewDashboard:false,companyId:'ABS_NORTH'}),true);
 assert.equal(saved.can_view_dashboard,false);assert.equal(saved.role,'accounting');assert.equal(saved.company_id,'ABS_NORTH');
});
test('database denies the disabled accountant dashboard, preserves sale/admin and other modules, enforces admin-only edits and reports own access through existing session check',async()=>{
 const db=await buildRetentionDatabase({maxVersion:128});
 try{
  const source=await readFile(new URL('../migrations/0129_accounting_dashboard_access.sql',import.meta.url),'utf8');
  const salesBefore=await (async()=>{await asActor(db,saleId);return scalar(db,"SELECT rpc_get_phase5_dashboard('{}') AS value");})();
  await db.exec('RESET ROLE');await db.exec(source);await db.exec(source);
  await asActor(db,accountingId);
  assert.equal((await scalar(db,'SELECT rpc_get_maintenance_status() AS value')).can_view_dashboard,true);
  await scalar(db,"SELECT rpc_get_phase5_dashboard('{}') AS value");
  await asActor(db,adminId);
  await db.query('UPDATE profiles SET can_view_dashboard=false WHERE auth_user_id=$1',[accountingId]);
  assert.equal(await scalar(db,"SELECT count(*) AS value FROM audit_logs WHERE action='DASHBOARD_PERMISSION'"),1);
  await asActor(db,accountingId);
  assert.equal((await scalar(db,'SELECT rpc_get_maintenance_status() AS value')).can_view_dashboard,false);
  await assert.rejects(scalar(db,"SELECT rpc_get_phase5_dashboard('{}') AS value"),/DASHBOARD_ACCESS_DENIED/);
  await db.query('UPDATE profiles SET can_view_dashboard=true WHERE auth_user_id=$1',[accountingId]);
  assert.equal(await scalar(db,'SELECT can_view_dashboard AS value FROM profiles WHERE auth_user_id=$1',[accountingId]),false);
  assert.equal((await scalar(db,'SELECT rpc_supplier_directory(0,20) AS value')).total,0);
  await asActor(db,saleId);const salesAfter=await scalar(db,"SELECT rpc_get_phase5_dashboard('{}') AS value");
  assert.deepEqual(salesAfter.summary,salesBefore.summary);
  await asActor(db,adminId);await db.query('UPDATE profiles SET can_view_dashboard=false WHERE auth_user_id=$1',[adminId]);
  await scalar(db,"SELECT rpc_get_phase5_dashboard('{}') AS value");assert.equal((await scalar(db,'SELECT rpc_get_maintenance_status() AS value')).can_view_dashboard,true);
  await db.query('UPDATE profiles SET can_view_dashboard=true WHERE auth_user_id=$1',[accountingId]);
  await asActor(db,accountingId);await scalar(db,"SELECT rpc_get_phase5_dashboard('{}') AS value");
  await db.exec('RESET ROLE;SET ROLE anon');await assert.rejects(scalar(db,"SELECT rpc_get_phase5_dashboard('{}') AS value"),/permission denied/);
 }finally{await db.close();}
});
