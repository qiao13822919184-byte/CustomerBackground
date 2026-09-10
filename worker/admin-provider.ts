import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env } from './env';
import type { User } from '../shared/types';
import { proposedProvider,providerFingerprint,providerValidated } from './user-provider';
import { getProvider } from './provider';
import { encryptSecret } from './security';
import { audit,id,now } from './db';
import { testProvider } from './research';
export const accountProviderRoutes=new Hono<{Bindings:Env;Variables:{user:User}}>();
accountProviderRoutes.use('/:id/*',async(c,next)=>{if(c.get('user').role!=='admin')throw new HTTPException(403,{message:'需要主管理员权限'});const uid=c.req.param('id');if(!uid||!await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(uid).first())throw new HTTPException(404,{message:'用户不存在'});await next();});
accountProviderRoutes.get('/:id/provider',async c=>{
 const uid=c.req.param('id'),row=await c.env.DB.prepare('SELECT * FROM user_providers WHERE user_id=?').bind(uid).first<any>();
 const p=row?(await proposedProvider(c.env,uid,{})).settings:await getProvider(c.env);
 const {api_key,search_api_key,public_fetch,...settings}=p;return c.json({settings,mode:row?.mode||'inherit',validated:await providerValidated(c.env,uid),tested_at:row?.tested_at||null});
});
accountProviderRoutes.post('/:id/provider/test',async c=>{
 const uid=c.req.param('id'),b=await c.req.json();let proposed;try{proposed=await proposedProvider(c.env,uid,b);}catch(e){return c.json({ok:false,error:(e as Error).message,message:(e as Error).message,tool_calling:false,analysis_ok:false},400);}
 const r=await testProvider(c.env,proposed.settings);const success=r.ok&&r.tool_calling&&(r as any).analysis_ok===true;
 if(!success)return c.json({...r,ok:false,test_id:null});
 const testId=id(),time=now();await c.env.DB.prepare('INSERT INTO provider_tests VALUES(?,?,?,?,?)').bind(testId,uid,await providerFingerprint(proposed.settings,proposed.mode),new Date(Date.now()+15*60000).toISOString(),time).run();await audit(c.env,null,c.get('user').id,'账号模型实测通过','user',uid,{model:proposed.settings.model});return c.json({...r,test_id:testId});
});
accountProviderRoutes.put('/:id/provider',async c=>{
 const uid=c.req.param('id'),b=await c.req.json();let proposed;try{proposed=await proposedProvider(c.env,uid,b);}catch(e){throw new HTTPException(400,{message:(e as Error).message});}
 const digest=await providerFingerprint(proposed.settings,proposed.mode);const proof=await c.env.DB.prepare('SELECT id FROM provider_tests WHERE id=? AND user_id=? AND config_hash=? AND expires_at>?').bind(String(b.test_id||''),uid,digest,now()).first();if(!proof)throw new HTTPException(409,{message:'请先测试当前配置；修改地址、密钥或模型后需要重新测试'});
 const s=proposed.settings,t=now();const key=proposed.mode==='dedicated'?await encryptSecret(s.api_key,c.env.ENCRYPTION_KEY):null;
 await c.env.DB.batch([c.env.DB.prepare('INSERT INTO user_providers VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode,api_url=excluded.api_url,api_key=excluded.api_key,model=excluded.model,alternate_model=excluded.alternate_model,config_hash=excluded.config_hash,tested_at=excluded.tested_at,updated_at=excluded.updated_at').bind(uid,proposed.mode,proposed.mode==='dedicated'?s.api_url:null,key,proposed.mode==='dedicated'?s.model:null,proposed.mode==='dedicated'?s.alternate_model:null,digest,t,t),c.env.DB.prepare('DELETE FROM provider_tests WHERE id=? OR expires_at<?').bind(b.test_id,t)]);
 await audit(c.env,null,c.get('user').id,'分配账号模型','user',uid,{mode:proposed.mode,model:s.model});return c.json({ok:true,validated:true,tested_at:t});
});
