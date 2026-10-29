export const STATUS_UPDATE_MS = 2 * 60 * 60 * 1000;
const dayKey = time => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
const counters = snapshot => {
  const t=snapshot?.totals || {};
  return {bytes:Math.max(0,Math.trunc(Number(t.estimatedResponseBytes)||0)),requests:Math.max(0,Math.trunc(Number(t.requests)||0)),truncated:Math.max(0,Math.trunc(Number(t.truncatedResponses)||0))};
};
// The browser only reports its own aggregate counters. Cumulative uploads are
// safe to retry; the server accepts only monotonic deltas for that actor/session.
export function createApplicationEgressReporter({snapshot,rpc,actor,now=Date.now,uuid=()=>crypto.randomUUID(),schedule=setInterval,cancel=clearInterval}) {
  let generation=0,scope='',sessionId='',day='',previous={bytes:0,requests:0,truncated:0},daily={...previous},pending=null,timer=null;
  const reset=()=>{generation++;scope='';sessionId='';day='';previous={bytes:0,requests:0,truncated:0};daily={...previous};pending=null;};
  const flush=()=>{
    if(pending)return pending;
    const owner=actor();if(!owner)return Promise.resolve(false);
    if(scope!==owner){reset();scope=owner;sessionId=uuid();}
    const version=generation;
    const task=(async()=>{
      const totals=counters(await snapshot());
      if(version!==generation||owner!==actor())return false;
      const today=dayKey(now());
      if(today!==day){day=today;daily={bytes:0,requests:0,truncated:0};}
      if(Object.keys(previous).some(key=>totals[key]<previous[key])){sessionId=uuid();previous={bytes:0,requests:0,truncated:0};daily={...previous};}
      for(const key of Object.keys(daily))daily[key]+=totals[key]-previous[key];
      previous=totals;
      if(!daily.requests&&!daily.bytes)return false;
      const result=await rpc('rpc_report_application_egress',{p_report:{actorId:owner,sessionId,day,...daily}});
      if(result?.error)throw result.error;
      return version===generation&&owner===actor();
    })();
    pending=task;
    void task.finally(()=>{if(pending===task)pending=null;}).catch(()=>{});
    return task;
  };
  return {flush,reset,start(){if(timer!==null)return;timer=schedule(()=>{void flush().catch(()=>{});},STATUS_UPDATE_MS);timer?.unref?.();},stop(){if(timer!==null)cancel(timer);timer=null;reset();}};
}
