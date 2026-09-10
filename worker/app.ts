import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from './env';
import type { Lead, User } from '../shared/types';
import { audit, canAccess, id, now, parseLead, safeUser } from './db';
import { constantEqual, encryptSecret, hashPassword, passwordValid, publicHttps, randomToken, sha256, verifyPassword } from './security';
import { getProvider } from './provider';
import { getUserProvider,providerValidated } from './user-provider';
import { accountProviderRoutes } from './admin-provider';
import { previewImport, testProvider } from './research';

type AppEnv={Bindings:Env;Variables:{user:User}};
export const app=new Hono<AppEnv>();
const fail=(status:400|401|403|404|409|429|503,message:string)=>{throw new HTTPException(status,{message});};
const clean=(v:unknown,max=500)=>typeof v==='string'?v.slice(0,max).trim():'';
const requireWrite=(u:User)=>{if(u.role==='viewer')fail(403,'只读账号不能修改记录');};
const requireAdmin=(u:User)=>{if(u.role!=='admin')fail(403,'需要主管理员权限');};
async function providerFor(c:any){try{return await getUserProvider(c.env,c.get('user').id);}catch(e){fail(503,(e as Error).message);}}
async function workspace(c:any,w:string){if(!w||!await canAccess(c.env,c.get('user'),w))fail(404,'工作区不存在或无访问权限');}
async function entity(c:any,table:'leads'|'advertisers'|'jobs',entityId:string){const r=await c.env.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(entityId).first();if(!r)fail(404,'记录不存在');await workspace(c,r.workspace_id);return r;}
async function json(c:any){try{return await c.req.json();}catch{fail(400,'请求必须为有效JSON');}}
function requestOrigin(c:any){const configured=c.env.APP_ORIGIN;return new URL(configured||c.req.url).origin;}
async function session(c:any,user:User){const token=randomToken();await c.env.DB.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)').bind(await sha256(token),user.id,new Date(Date.now()+7*86400000).toISOString(),now()).run();setCookie(c,'cb_session',token,{httpOnly:true,secure:new URL(requestOrigin(c)).protocol==='https:',sameSite:'Strict',path:'/',maxAge:7*86400});}

app.use('/api/*',bodyLimit({maxSize:12*1024*1024,onError:c=>c.json({error:'单次材料总量不能超过12MB，请压缩图片或拆分上传'},413)}));
app.use('/api/*',async(c,next)=>{
  c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','no-referrer');
  if(!['GET','HEAD','OPTIONS'].includes(c.req.method)){
    const origin=c.req.header('Origin');if(origin&&origin!==requestOrigin(c))fail(403,'不允许跨站写入');
    if(c.req.header('Sec-Fetch-Site')==='cross-site')fail(403,'不允许跨站请求');
    if(!c.req.header('Content-Type')?.toLowerCase().includes('application/json'))fail(400,'写入请求必须使用application/json');
  }
  if(['/api/auth/status','/api/auth/login','/api/auth/setup'].includes(c.req.path)){await next();return;}
  const token=getCookie(c,'cb_session');if(!token)fail(401,'请先登录');
  const row=await c.env.DB.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').bind(await sha256(token!),now()).first<Record<string,unknown>>();if(!row)fail(401,'登录已过期，请重新登录');
  const user=safeUser(row!);c.set('user',user);
  if(user.must_change_password&&!['/api/auth/me','/api/auth/password','/api/auth/logout'].includes(c.req.path))fail(403,'首次登录请先修改密码');
  await next();
});
app.onError((err,c)=>{if(err instanceof HTTPException)return c.json({error:err.message},err.status);return c.json({error:'服务处理失败，请稍后重试；若持续失败请联系管理员',code:'INTERNAL_ERROR'},500);});

app.get('/api/auth/status',async c=>c.json({initialized:!!await c.env.DB.prepare('SELECT id FROM users LIMIT 1').first()}));
app.post('/api/auth/setup',async c=>{
  const b=await json(c);if(!c.env.BOOTSTRAP_TOKEN||!constantEqual(String(b.token||''),c.env.BOOTSTRAP_TOKEN))fail(403,'初始化令牌无效');
  if(!passwordValid(b.password)||!/^[a-zA-Z0-9_.-]{3,40}$/.test(b.username||''))fail(400,'用户名需3至40位字母数字，密码至少12位');
  if(await c.env.DB.prepare('SELECT id FROM users LIMIT 1').first())fail(409,'系统已经初始化');
  const uid=id(),wid=id(),time=now(),hash=await hashPassword(b.password);
  const res=await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO users(id,username,display_name,password_hash,role,created_at) SELECT ?,?,?,?,'admin',? WHERE NOT EXISTS(SELECT 1 FROM users)").bind(uid,b.username,clean(b.display_name)||b.username,hash,time),
    c.env.DB.prepare("INSERT INTO workspaces(id,name,created_at) SELECT ?,'团队工作区',? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)").bind(wid,time,uid),
    c.env.DB.prepare('INSERT INTO memberships(workspace_id,user_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)').bind(wid,uid,uid)
  ]);if(!res[0].meta.changes)fail(409,'系统已由其他会话初始化');
  const user=safeUser((await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first())!);await session(c,user);await audit(c.env,wid,uid,'初始化系统','workspace',wid);return c.json({user},201);
});
app.post('/api/auth/login',async c=>{
  const b=await json(c);const username=clean(b.username,40).toLowerCase();
  // A username bucket cannot be reset by spoofing proxy headers or changing IPs.
  const bucket=await sha256(`login:${username}`);const cutoff=new Date(Date.now()-15*60000).toISOString();
  const attempts=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE bucket=? AND created_at>?').bind(bucket,cutoff).first<{n:number}>();if((attempts?.n||0)>=8)fail(429,'尝试次数过多，请15分钟后再试');
  await c.env.DB.prepare('INSERT INTO login_attempts VALUES(?,?,?)').bind(id(),bucket,now()).run();
  const row=await c.env.DB.prepare('SELECT * FROM users WHERE username=?').bind(username).first<Record<string,unknown>>();
  const valid=await verifyPassword(String(b.password||'').slice(0,128),String(row?.password_hash||'pbkdf2:100000:dummy:invalid'));if(!row||!row.active||!valid)fail(401,'用户名或密码不正确');
  await c.env.DB.prepare('DELETE FROM login_attempts WHERE bucket=? OR created_at<?').bind(bucket,cutoff).run();await c.env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now()).run();
  const user=safeUser(row!);await session(c,user);return c.json({user});
});
app.get('/api/auth/me',c=>c.json({user:c.get('user')}));
app.post('/api/auth/logout',async c=>{await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(getCookie(c,'cb_session')||'')).run();deleteCookie(c,'cb_session',{path:'/'});return c.json({ok:true});});
app.post('/api/auth/password',async c=>{const b=await json(c),u=c.get('user');if(!passwordValid(b.password))fail(400,'新密码至少12位');const row=await c.env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(u.id).first<{password_hash:string}>();if(!await verifyPassword(String(b.current_password||''),row!.password_hash))fail(400,'当前密码不正确');await c.env.DB.batch([c.env.DB.prepare('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?').bind(await hashPassword(b.password),u.id),c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id)]);await session(c,{...u,must_change_password:0});return c.json({ok:true});});

app.get('/api/workspaces',async c=>{const u=c.get('user');const r=u.role==='admin'?await c.env.DB.prepare('SELECT * FROM workspaces ORDER BY created_at').all():await c.env.DB.prepare('SELECT w.* FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.created_at').bind(u.id).all();return c.json({workspaces:r.results});});
app.post('/api/workspaces',async c=>{const u=c.get('user');requireAdmin(u);const b=await json(c),name=clean(b.name,100);if(!name)fail(400,'请输入工作区名称');const w={id:id(),name,created_at:now()};await c.env.DB.batch([c.env.DB.prepare('INSERT INTO workspaces VALUES(?,?,?)').bind(w.id,w.name,w.created_at),c.env.DB.prepare('INSERT INTO memberships VALUES(?,?)').bind(w.id,u.id)]);return c.json({workspace:w},201);});
app.get('/api/workspaces/:id/members',async c=>{await workspace(c,c.req.param('id'));const rows=await c.env.DB.prepare('SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=? AND (u.active=1 OR ?=1)').bind(c.req.param('id'),c.get('user').role==='admin'?1:0).all<Record<string,unknown>>();return c.json({users:rows.results.map(safeUser)});});
app.put('/api/workspaces/:id/members',async c=>{requireAdmin(c.get('user'));const w=c.req.param('id');await workspace(c,w);const b=await json(c);if(!Array.isArray(b.user_ids)||b.user_ids.length>500)fail(400,'无效成员列表');const ids=[...new Set<string>([...b.user_ids,c.get('user').id])];for(const uid of ids)if(!await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(uid).first())fail(400,'成员不存在');await c.env.DB.batch([c.env.DB.prepare('DELETE FROM memberships WHERE workspace_id=?').bind(w),...ids.map(uid=>c.env.DB.prepare('INSERT INTO memberships VALUES(?,?)').bind(w,uid))]);await audit(c.env,w,c.get('user').id,'更新团队成员','workspace',w);return c.json({ok:true});});

app.get('/api/advertisers',async c=>{const w=c.req.query('workspace_id')||'';await workspace(c,w);return c.json({advertisers:(await c.env.DB.prepare('SELECT * FROM advertisers WHERE workspace_id=? ORDER BY updated_at DESC').bind(w).all()).results});});
app.post('/api/advertisers',async c=>{const u=c.get('user');requireWrite(u);const b=await json(c);await workspace(c,b.workspace_id);if(!clean(b.name))fail(400,'请输入广告主名称');const a={id:id(),workspace_id:b.workspace_id,name:clean(b.name,200),profile_md:clean(b.profile_md,500000),version:1,created_at:now(),updated_at:now()};await c.env.DB.batch([c.env.DB.prepare('INSERT INTO advertisers VALUES(?,?,?,?,?,?,?)').bind(...Object.values(a)),c.env.DB.prepare('INSERT INTO advertiser_versions VALUES(?,?,?,?,?,?)').bind(id(),a.id,1,a.profile_md,u.id,a.created_at)]);await audit(c.env,a.workspace_id,u.id,'创建广告主','advertiser',a.id);return c.json({advertiser:a},201);});
app.patch('/api/advertisers/:id',async c=>{const u=c.get('user');requireWrite(u);const a=await entity(c,'advertisers',c.req.param('id')),b=await json(c);if(b.version!==a.version)fail(409,'档案已更新，请比较最新版本后再保存');const name=b.name===undefined?a.name:clean(b.name,200),md=b.profile_md===undefined?a.profile_md:clean(b.profile_md,500000);if(!name)fail(400,'名称不能为空');const t=now();const r=await c.env.DB.batch([c.env.DB.prepare('UPDATE advertisers SET name=?,profile_md=?,version=version+1,updated_at=? WHERE id=? AND version=?').bind(name,md,t,a.id,b.version),c.env.DB.prepare('INSERT INTO advertiser_versions(id,advertiser_id,version,profile_md,user_id,created_at) SELECT ?,id,version,profile_md,?,? FROM advertisers WHERE id=? AND version=? AND changes()=1').bind(id(),u.id,t,a.id,b.version+1),c.env.DB.prepare('SELECT * FROM advertisers WHERE id=? AND version=?').bind(a.id,b.version+1)]);if(!r[0].meta.changes)fail(409,'另一个成员刚刚保存了此档案，请重新加载');await audit(c.env,a.workspace_id,u.id,'更新广告主档案','advertiser',a.id,{version:b.version+1});return c.json({advertiser:r[2].results[0]});});
app.get('/api/advertisers/:id/versions',async c=>{const a=await entity(c,'advertisers',c.req.param('id'));return c.json({versions:(await c.env.DB.prepare('SELECT * FROM advertiser_versions WHERE advertiser_id=? ORDER BY version DESC').bind(a.id).all()).results});});

const textFields=['name','company','email','phone','website','country','city','product','business_type','customization'] as const;
function preparedLead(env:Env,u:User,w:string,aid:string,b:any){
 if(!b||typeof b!=='object'||Array.isArray(b))fail(400,'每条客户必须是记录对象');
 const time=now(),fields=Object.fromEntries(textFields.map(k=>[k,clean(b[k],2000)]));const raw=JSON.stringify(b.raw&&typeof b.raw==='object'?b.raw:b);if(raw.length>100000)fail(400,'单条原始线索内容过长');
 const lead={id:id(),workspace_id:w,advertiser_id:aid,...fields,raw:JSON.parse(raw),status:'new',owner_id:null,notes:'',version:1,match_level:null,priority:null,industry:'',fit:'',created_at:time,updated_at:time} as Lead;
 return {lead,statements:[env.DB.prepare(`INSERT INTO leads(id,workspace_id,advertiser_id,${textFields.join(',')},raw,created_at,updated_at) VALUES(${Array(16).fill('?').join(',')})`).bind(lead.id,w,aid,...textFields.map(k=>fields[k]),raw,time,time),env.DB.prepare('INSERT INTO lead_versions VALUES(?,?,?,?,?,?)').bind(id(),lead.id,1,JSON.stringify(lead),u.id,time)]};
}
async function insertLead(env:Env,u:User,w:string,aid:string,b:any):Promise<Lead>{const prepared=preparedLead(env,u,w,aid,b);await env.DB.batch(prepared.statements);return prepared.lead;}
const leadSnapshotSql=`json_object('id',id,'workspace_id',workspace_id,'advertiser_id',advertiser_id,${textFields.map(k=>`'${k}',${k}`).join(',')},'raw',json(raw),'status',status,'owner_id',owner_id,'notes',notes,'version',version,'match_level',match_level,'priority',priority,'industry',industry,'fit',fit,'created_at',created_at,'updated_at',updated_at)`;
app.get('/api/leads',async c=>{const w=c.req.query('workspace_id')||'';await workspace(c,w);const aid=c.req.query('advertiser_id');const stmt=aid?c.env.DB.prepare('SELECT * FROM leads WHERE workspace_id=? AND advertiser_id=? ORDER BY updated_at DESC LIMIT 5000').bind(w,aid):c.env.DB.prepare('SELECT * FROM leads WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 5000').bind(w);return c.json({leads:(await stmt.all<Record<string,unknown>>()).results.map(parseLead)});});
app.post('/api/leads/import/preview',async c=>{
 const u=c.get('user');requireWrite(u);const b=await json(c),text=clean(b.text,500000);if(!text&&!b.materials?.length)fail(400,'请先粘贴或上传客户表单');
 const settings=(await providerFor(c))!,callId=id(),time=now(),day=time.slice(0,10);
 const reserved=await c.env.DB.prepare(`INSERT INTO api_calls(id,user_id,kind,status,model,created_at,updated_at) SELECT ?,?,'import_preview','running',?,?,? WHERE ${quotaPredicate}`).bind(callId,u.id,settings.model,time,time,u.id,day,u.id,day,u.id).run();
 if(!reserved.meta.changes)fail(429,'今日任务与解析额度已用完，请联系管理员');
 try{const result=await previewImport(c.env,text,b.materials||[],settings);await c.env.DB.prepare("UPDATE api_calls SET status='completed',input_tokens=?,output_tokens=?,updated_at=? WHERE id=?").bind(result.usage?.input_tokens||0,result.usage?.output_tokens||0,now(),callId).run();return c.json(result);}
 catch(error){await c.env.DB.prepare("UPDATE api_calls SET status='failed',updated_at=? WHERE id=?").bind(now(),callId).run();throw error;}
});
app.post('/api/leads/import',async c=>{const u=c.get('user');requireWrite(u);const b=await json(c);await workspace(c,b.workspace_id);const a=await entity(c,'advertisers',b.advertiser_id);if(a.workspace_id!==b.workspace_id)fail(400,'广告主不属于当前工作区');if(!Array.isArray(b.leads)||!b.leads.length||b.leads.length>100)fail(400,'每批请导入1至100条');const prepared=b.leads.map((input:unknown)=>preparedLead(c.env,u,b.workspace_id,b.advertiser_id,input));await c.env.DB.batch(prepared.flatMap((p:ReturnType<typeof preparedLead>)=>p.statements));const leads=prepared.map((p:ReturnType<typeof preparedLead>)=>p.lead);await audit(c.env,b.workspace_id,u.id,'批量导入客户','advertiser',b.advertiser_id,{count:leads.length});return c.json({leads},201);});
app.post('/api/leads',async c=>{const u=c.get('user');requireWrite(u);const b=await json(c);await workspace(c,b.workspace_id);const a=await entity(c,'advertisers',b.advertiser_id);if(a.workspace_id!==b.workspace_id)fail(400,'广告主归属错误');const lead=await insertLead(c.env,u,b.workspace_id,b.advertiser_id,b);await audit(c.env,b.workspace_id,u.id,'创建客户','lead',lead.id);return c.json({lead},201);});
app.get('/api/leads/:id',async c=>{const row=await entity(c,'leads',c.req.param('id'));const reports=(await c.env.DB.prepare('SELECT * FROM reports WHERE lead_id=? ORDER BY created_at DESC').bind(row.id).all<any>()).results.map(r=>({...r,result_json:JSON.parse(r.result_json),evidence:JSON.parse(r.evidence_json),evidence_json:undefined}));const events=(await c.env.DB.prepare('SELECT e.*,u.display_name AS username FROM audit_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.entity_id=? ORDER BY e.created_at DESC LIMIT 100').bind(row.id).all()).results;const jobs=(await c.env.DB.prepare('SELECT id,workspace_id,lead_id,advertiser_id,kind,status,stage,error,model,created_at,updated_at FROM jobs WHERE lead_id=? ORDER BY created_at DESC').bind(row.id).all()).results;return c.json({lead:parseLead(row),reports,events,jobs});});
app.patch('/api/leads/:id',async c=>{
 const u=c.get('user');requireWrite(u);const row=await entity(c,'leads',c.req.param('id')),b=await json(c);if(b.version!==row.version)fail(409,'其他成员已更新此客户，请先对比最新记录');
 const allowed=[...textFields,'notes','status','owner_id'];const fields:string[]=[],values:any[]=[];
 for(const key of allowed)if(b[key]!==undefined){if(key==='owner_id'){if(b[key]&&!await c.env.DB.prepare('SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.id=? AND m.workspace_id=? AND u.active=1').bind(b[key],row.workspace_id).first())fail(400,'负责人必须是当前团队的有效成员');values.push(b[key]||null);}else values.push(clean(b[key],key==='notes'?30000:2000));fields.push(`${key}=?`);}
 if(!fields.length)return c.json({lead:parseLead(row)});const t=now(),nextVersion=b.version+1;values.push(t,row.id,b.version);
 // Compare-and-swap, immutable snapshot, and the exact response revision share one transaction.
 const result=await c.env.DB.batch([
  c.env.DB.prepare(`UPDATE leads SET ${fields.join(',')},version=version+1,updated_at=? WHERE id=? AND version=?`).bind(...values),
  c.env.DB.prepare(`INSERT INTO lead_versions(id,lead_id,version,snapshot,user_id,created_at) SELECT ?,id,version,${leadSnapshotSql},?,? FROM leads WHERE id=? AND version=? AND changes()=1`).bind(id(),u.id,t,row.id,nextVersion),
  c.env.DB.prepare('SELECT snapshot FROM lead_versions WHERE lead_id=? AND version=?').bind(row.id,nextVersion)
 ]);
 if(!result[0].meta.changes)fail(409,'发生同时编辑冲突，草稿未覆盖远端记录');const lead=JSON.parse((result[2].results[0] as {snapshot:string}).snapshot) as Lead;
 await audit(c.env,row.workspace_id,u.id,'更新客户记录','lead',row.id,{fields:allowed.filter(k=>b[k]!==undefined),version:nextVersion});return c.json({lead});
});
app.get('/api/leads/:id/export',async c=>{const row=await entity(c,'leads',c.req.param('id'));const reports=(await c.env.DB.prepare('SELECT content_md FROM reports WHERE lead_id=? ORDER BY created_at DESC').bind(row.id).all<{content_md:string}>()).results;const body=`# ${row.company||row.name||'客户'}\n\n导出时间：${now()}\n\n## 原始信息\n\n\`\`\`json\n${JSON.stringify(parseLead(row),null,2)}\n\`\`\`\n\n${reports.map(r=>r.content_md).join('\n\n---\n\n')}`;c.header('Content-Disposition',`attachment; filename="lead-${row.id}.md"`);return c.text(body,200,{'Content-Type':'text/markdown; charset=utf-8'});});
app.get('/api/leads/:id/versions',async c=>{const row=await entity(c,'leads',c.req.param('id'));return c.json({versions:(await c.env.DB.prepare('SELECT * FROM lead_versions WHERE lead_id=? ORDER BY version DESC').bind(row.id).all()).results});});

const quotaPredicate="((SELECT COUNT(*) FROM jobs WHERE user_id=? AND created_at>=?)+(SELECT COUNT(*) FROM api_calls WHERE user_id=? AND created_at>=?)) < COALESCE((SELECT daily_limit FROM users WHERE id=? AND active=1),0)";
async function enqueue(c:any,kind:'research'|'profile',a:any,lead:any|null,materials:any[]=[]){const u=c.get('user') as User;requireWrite(u);const settings=(await providerFor(c))!;if(!settings.api_key)fail(503,'管理员尚未配置模型API密钥');if(kind==='research'&&!a.profile_md.trim())fail(400,'请先为广告主建立档案');const jid=id(),t=now(),day=t.slice(0,10);const payload=JSON.stringify({lead:lead?parseLead(lead):null,advertiser:a,materials});if(payload.length>10*1024*1024)fail(400,'材料过大，请拆分分析');let inserted;try{inserted=await c.env.DB.prepare(`INSERT INTO jobs(id,workspace_id,lead_id,advertiser_id,user_id,kind,status,stage,model,profile_version,lead_version,created_at,updated_at) SELECT ?,?,?,?,?,?,'queued','等待执行',?,?,?,?,? WHERE ${quotaPredicate}`).bind(jid,a.workspace_id,lead?.id||null,a.id,u.id,kind,settings.model,a.version,lead?.version||null,t,t,u.id,day,u.id,day,u.id).run();}catch{fail(409,'该客户或档案已有任务正在处理');}if(!inserted!.meta.changes)fail(429,'今日任务与解析额度已用完，请联系管理员');
 const chunks=[];for(let i=0;i<payload.length;i+=100000)chunks.push(c.env.DB.prepare('INSERT INTO job_payloads VALUES(?,?,?)').bind(jid,Math.floor(i/100000),payload.slice(i,i+100000)));await c.env.DB.batch(chunks);
 try{await c.env.RESEARCH.create({id:jid,params:{job_id:jid}});}catch{await c.env.DB.prepare("UPDATE jobs SET status='failed',stage='启动失败',error='后台任务服务未就绪',updated_at=? WHERE id=?").bind(now(),jid).run();fail(503,'后台任务服务未就绪，请联系管理员');}
 await audit(c.env,a.workspace_id,u.id,kind==='research'?'启动背调':'分析广告主资料',lead?'lead':'advertiser',lead?.id||a.id,{job_id:jid});return await c.env.DB.prepare('SELECT id,workspace_id,lead_id,advertiser_id,kind,status,stage,error,model,created_at,updated_at FROM jobs WHERE id=?').bind(jid).first();
}
app.post('/api/leads/:id/research',async c=>{const l=await entity(c,'leads',c.req.param('id')),a=await entity(c,'advertisers',l.advertiser_id);return c.json({job:await enqueue(c,'research',a,l)},202);});
app.post('/api/advertisers/:id/analyze',async c=>{const a=await entity(c,'advertisers',c.req.param('id')),b=await json(c);if(!Array.isArray(b.materials)||!b.materials.length||b.materials.length>30)fail(400,'请提供1至30份材料');return c.json({job:await enqueue(c,'profile',a,null,b.materials)},202);});
app.get('/api/jobs',async c=>{const w=c.req.query('workspace_id')||'';await workspace(c,w);return c.json({jobs:(await c.env.DB.prepare('SELECT id,workspace_id,lead_id,advertiser_id,kind,status,stage,error,model,input_tokens,output_tokens,created_at,updated_at FROM jobs WHERE workspace_id=? ORDER BY created_at DESC LIMIT 300').bind(w).all()).results});});
app.post('/api/jobs/:id/cancel',async c=>{requireWrite(c.get('user'));const j=await entity(c,'jobs',c.req.param('id'));await c.env.DB.prepare("UPDATE jobs SET status='cancelled',stage='已取消',updated_at=? WHERE id=? AND status IN ('running','queued')").bind(now(),j.id).run();try{await(await c.env.RESEARCH.get(j.id)).terminate();}catch{}await audit(c.env,j.workspace_id,c.get('user').id,'取消任务',j.lead_id?'lead':'advertiser',j.lead_id||j.advertiser_id,{job_id:j.id});return c.json({ok:true});});
app.get('/api/events',async c=>{const w=c.req.query('workspace_id')||'';await workspace(c,w);const t=now(),since=c.req.query('since')||new Date(Date.now()-86400000).toISOString();const events=(await c.env.DB.prepare('SELECT e.*,u.display_name AS username FROM audit_events e LEFT JOIN users u ON u.id=e.user_id WHERE e.workspace_id=? AND e.created_at>=? ORDER BY e.created_at DESC LIMIT 200').bind(w,since).all()).results;return c.json({events,server_time:t});});

app.get('/api/admin/users',async c=>{requireAdmin(c.get('user'));return c.json({users:(await c.env.DB.prepare('SELECT * FROM users ORDER BY created_at').all<Record<string,unknown>>()).results.map(safeUser)});});
app.post('/api/admin/users',async c=>{requireAdmin(c.get('user'));const b=await json(c);if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(b.username||'')||!passwordValid(b.password)||!['admin','manager','member','viewer'].includes(b.role))fail(400,'请检查用户名、角色和至少12位密码');if(await c.env.DB.prepare('SELECT id FROM users WHERE username=?').bind(b.username).first())fail(409,'用户名已存在');const uid=id(),time=now(),limit=Math.min(1000,Math.max(0,b.daily_limit===undefined?20:Number(b.daily_limit)||0));const ids=Array.isArray(b.workspace_ids)?[...new Set<string>(b.workspace_ids)]:[];for(const w of ids)await workspace(c,w);await c.env.DB.batch([c.env.DB.prepare('INSERT INTO users(id,username,display_name,password_hash,role,daily_limit,active,must_change_password,created_at) VALUES(?,?,?,?,?,?,0,1,?)').bind(uid,b.username.toLowerCase(),clean(b.display_name)||b.username,await hashPassword(b.password),b.role,limit,time),...ids.map(w=>c.env.DB.prepare('INSERT INTO memberships VALUES(?,?)').bind(w,uid))]);return c.json({user:safeUser((await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first())!)},201);});
app.patch('/api/admin/users/:id',async c=>{const current=c.get('user');requireAdmin(current);const uid=c.req.param('id'),b=await json(c);const user=await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first<any>();if(!user)fail(404,'用户不存在');if(b.active!==undefined&&b.active!==0&&b.active!==1)fail(400,'active必须是0或1');if(b.active===1&&user.active!==1&&!(await providerValidated(c.env,uid)))fail(409,'请先为此账号配置模型并通过实际分析测试');if(uid===current.id&&(b.active===0||(b.role&&b.role!=='admin')))fail(400,'不能停用或降级当前管理员');const fields:string[]=[],vals:any[]=[];for(const k of ['active','role','daily_limit','display_name'])if(b[k]!==undefined){if(k==='role'&&!['admin','manager','member','viewer'].includes(b[k]))fail(400,'角色无效');fields.push(`${k}=?`);vals.push(k==='active'?(b[k]?1:0):k==='daily_limit'?Math.min(1000,Math.max(0,Number(b[k])||0)):clean(b[k]));}if(b.password){if(!passwordValid(b.password))fail(400,'密码至少12位');fields.push('password_hash=?','must_change_password=1');vals.push(await hashPassword(b.password));}if(fields.length){vals.push(uid);await c.env.DB.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).bind(...vals).run();if(b.password||b.active===0||(b.role&&b.role!==user.role))await c.env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(uid).run();}await audit(c.env,null,current.id,'更新账号权限','user',uid,{fields:Object.keys(b).filter(k=>k!=='password')});return c.json({user:safeUser((await c.env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first())!)});});
app.get('/api/admin/settings',async c=>{requireAdmin(c.get('user'));const {api_key,search_api_key, ...settings}=await getProvider(c.env);return c.json({settings});});
app.put('/api/admin/settings',async c=>{requireAdmin(c.get('user'));const b=await json(c);const old=await getProvider(c.env);const newUrl=b.api_url===undefined?old.api_url:publicHttps(clean(b.api_url,1000));if(new URL(newUrl).origin!==new URL(old.api_url).origin&&!clean(b.api_key,2000))fail(400,'更换API域名时必须同时输入新密钥，原密钥不会发送到新域名');const values:Record<string,string>={api_url:newUrl};for(const k of ['model','alternate_model'])if(b[k]!==undefined){const s=clean(b[k],300);if(!s)fail(400,'模型名称不能为空');values[k]=s;}if(b.search_provider!==undefined){if(!['bing','brave'].includes(b.search_provider))fail(400,'搜索服务无效');values.search_provider=b.search_provider;}if(b.max_steps!==undefined)values.max_steps=String(Math.max(3,Math.min(18,Number(b.max_steps)||10)));for(const k of ['api_key','search_api_key'])if(clean(b[k],2000))values[k]=await encryptSecret(b[k].trim(),c.env.ENCRYPTION_KEY);await c.env.DB.batch(Object.entries(values).map(([k,v])=>c.env.DB.prepare('INSERT INTO settings(id,value,updated_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(k,v,now())));await audit(c.env,null,c.get('user').id,'更新模型配置','settings','provider',{fields:Object.keys(values)});return c.json({ok:true});});
app.post('/api/admin/test',async c=>{requireAdmin(c.get('user'));const b=await json(c),settings=await getProvider(c.env);if(!settings.api_key)fail(400,'请先保存API密钥');return c.json(await testProvider(c.env,settings,clean(b.model,300)||undefined));});
app.get('/api/admin/usage',async c=>{requireAdmin(c.get('user'));return c.json({usage:(await c.env.DB.prepare('SELECT u.username,u.display_name,COUNT(j.id) AS jobs,COALESCE(SUM(j.input_tokens),0) AS input_tokens,COALESCE(SUM(j.output_tokens),0) AS output_tokens FROM users u LEFT JOIN (SELECT id,user_id,input_tokens,output_tokens FROM jobs UNION ALL SELECT id,user_id,input_tokens,output_tokens FROM api_calls) j ON j.user_id=u.id GROUP BY u.id').all()).results});});
app.get('/api/jobs/:id/result',async c=>{const j=await entity(c,'jobs',c.req.param('id'));const r=await c.env.DB.prepare('SELECT profile_md FROM profile_proposals WHERE job_id=?').bind(j.id).first<{profile_md:string}>();if(!r)fail(404,'此任务没有可下载的档案输出');c.header('Content-Disposition',`attachment; filename="profile-${j.id}.md"`);return c.text(r!.profile_md,200,{'Content-Type':'text/markdown; charset=utf-8'});});
app.route('/api/admin/users',accountProviderRoutes);
app.all('/api/*',c=>c.json({error:'接口不存在'},404));
app.get('*',c=>c.env.ASSETS.fetch(c.req.raw));
