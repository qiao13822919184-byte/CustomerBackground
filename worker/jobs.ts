import type { Env } from './env';
import { audit, id, now, canAccess, safeUser } from './db';
import { getProvider } from './provider';
import { getUserProvider } from './user-provider';
import { researchLead, buildProfile } from './research';
export async function runJob(env:Env,jobId:string){
 const job=await env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobId).first<any>();if(!job||job.status!=='queued')return;
 const start=await env.DB.prepare("UPDATE jobs SET status='running',stage='准备资料与模型',updated_at=? WHERE id=? AND status='queued'").bind(now(),jobId).run();if(!start.meta.changes)return;
 const progress=async(stage:string)=>{const r=await env.DB.prepare("UPDATE jobs SET stage=?,updated_at=? WHERE id=? AND status='running'").bind(stage.slice(0,300),now(),jobId).run();if(!r.meta.changes)throw new Error('TASK_CANCELLED');};
 try{
  const currentUser=await env.DB.prepare('SELECT * FROM users WHERE id=? AND active=1').bind(job.user_id).first<Record<string,unknown>>();
  if(!currentUser||!await canAccess(env,safeUser(currentUser),job.workspace_id))throw new Error('账号或工作区权限已变更，任务未继续执行');
  const chunks=(await env.DB.prepare('SELECT content FROM job_payloads WHERE job_id=? ORDER BY seq').bind(jobId).all<{content:string}>()).results;
  const payload=JSON.parse(chunks.map(x=>x.content).join(''));const assigned=await getUserProvider(env,job.user_id);if(assigned.model!==job.model)throw new Error('账号模型配置在排队期间已变更，请重新发起任务');const settings=assigned;
  if(job.kind==='profile'){
   const result=await buildProfile(env,payload.advertiser,payload.materials,settings,progress);await progress('保存广告主档案');const time=now();
   await env.DB.prepare('INSERT OR IGNORE INTO profile_proposals VALUES(?,?,?,?,?)').bind(jobId,job.advertiser_id,job.profile_version,result.profile_md,time).run();
   const results=await env.DB.batch([
    env.DB.prepare("UPDATE advertisers SET profile_md=?,version=version+1,updated_at=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running')").bind(result.profile_md,time,job.advertiser_id,job.profile_version,jobId),
    env.DB.prepare('INSERT OR IGNORE INTO advertiser_versions(id,advertiser_id,version,profile_md,user_id,created_at) SELECT ?,id,version,profile_md,?,? FROM advertisers WHERE id=? AND version=? AND updated_at=?').bind(id(),job.user_id,time,job.advertiser_id,job.profile_version+1,time)
   ]);
   if(!results[0].meta.changes){await env.DB.prepare("UPDATE jobs SET status='failed',stage='档案版本冲突',error='分析期间档案已修改；生成结果已保留，请从任务输出下载后比较合并',updated_at=? WHERE id=? AND status='running'").bind(now(),jobId).run();return;}
   await env.DB.prepare("UPDATE jobs SET status='completed',stage='档案已更新并保留旧版本',input_tokens=?,output_tokens=?,updated_at=? WHERE id=? AND status='running'").bind(result.usage?.input_tokens||0,result.usage?.output_tokens||0,now(),jobId).run();
  }else{
   const result=await researchLead(env,payload.lead,payload.advertiser,settings,progress);await progress('保存证据与研究报告');const time=now();
   const match=Number(result.result_json.match_level),priority=Number(result.result_json.priority);
   await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO reports(id,lead_id,job_id,content_md,result_json,evidence_json,model,profile_version,created_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running')").bind(id(),job.lead_id,jobId,result.content_md,JSON.stringify(result.result_json),JSON.stringify(result.evidence),job.model,job.profile_version,time,jobId),
    env.DB.prepare("UPDATE leads SET match_level=?,priority=?,industry=?,fit=?,version=version+1,updated_at=? WHERE id=? AND version=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running') AND EXISTS(SELECT 1 FROM advertisers WHERE id=? AND version=?)").bind([1,2,3].includes(match)?match:1,[1,2,3,4,5].includes(priority)?priority:2,String(result.result_json.industry||'未知').slice(0,2000),String(result.result_json.fit||'信息不足').slice(0,1000),time,job.lead_id,job.lead_version,jobId,job.advertiser_id,job.profile_version),
    env.DB.prepare("UPDATE jobs SET status='completed',stage='研究完成，可查看来源与报告',input_tokens=?,output_tokens=?,updated_at=? WHERE id=? AND status='running'").bind(result.usage?.input_tokens||0,result.usage?.output_tokens||0,time,jobId)
   ]);
  }
  await audit(env,job.workspace_id,job.user_id,job.kind==='research'?'背调任务完成':'广告主分析完成',job.lead_id?'lead':'advertiser',job.lead_id||job.advertiser_id,{job_id:jobId,profile_version:job.profile_version,model:job.model});
 }catch(error){
  const message=error instanceof Error?error.message:'模型或网络服务失败';const safe=message.replace(/sk-[a-zA-Z0-9_-]+/g,'[redacted]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,600);
  await env.DB.prepare("UPDATE jobs SET status='failed',stage='执行未完成',error=?,updated_at=? WHERE id=? AND status='running'").bind(safe==='TASK_CANCELLED'?'任务已取消':safe,now(),jobId).run();
  await audit(env,job.workspace_id,job.user_id,'任务结束',job.lead_id?'lead':'advertiser',job.lead_id||job.advertiser_id,{job_id:jobId});
 }
}
