import type { Env } from './env';
import { getProvider, type PrivateProvider } from './provider';
import { decryptSecret, publicHttps, sha256 } from './security';
export async function providerFingerprint(settings:PrivateProvider,mode:string){return sha256(JSON.stringify({mode,url:settings.api_url,key:settings.api_key,model:settings.model,alternate:settings.alternate_model}));}
export async function proposedProvider(env:Env,userId:string,b:any):Promise<{settings:PrivateProvider,mode:'inherit'|'dedicated'}>{
 const base=await getProvider(env);const previous=await env.DB.prepare('SELECT * FROM user_providers WHERE user_id=?').bind(userId).first<any>();const mode=b.mode||previous?.mode||'inherit';
 if(mode==='inherit')return {settings:base,mode};if(mode!=='dedicated')throw new Error('配置模式无效');
 const api_key=typeof b.api_key==='string'&&b.api_key.trim()?b.api_key.trim():(previous?.mode==='dedicated'&&previous.api_key?await decryptSecret(previous.api_key,env.ENCRYPTION_KEY):'');
 if(!api_key)throw new Error('独立配置需要输入该账号的API密钥');
 const api_url=publicHttps(String(b.api_url||previous?.api_url||base.api_url));const model=String(b.model||previous?.model||base.model).trim();if(!model||model.length>300)throw new Error('请输入有效模型名称');
 if(previous?.mode==='dedicated'&&new URL(api_url).origin!==new URL(previous.api_url).origin&&!b.api_key?.trim())throw new Error('更换API域名时必须提供新密钥');
 return {mode,settings:{...base,api_url,api_key,model,alternate_model:String(b.alternate_model||previous?.alternate_model||base.alternate_model).slice(0,300),key_configured:true}};
}
export async function getUserProvider(env:Env,userId:string,allowUntested=false):Promise<PrivateProvider>{
 const previous=await env.DB.prepare('SELECT * FROM user_providers WHERE user_id=?').bind(userId).first<any>();
 const user=await env.DB.prepare('SELECT role,active FROM users WHERE id=?').bind(userId).first<{role:string,active:number}>();
 if(!user?.active&&!allowUntested)throw new Error('账号已停用');
 if(!previous){if(user?.role==='admin'||allowUntested)return getProvider(env);throw new Error('此账号尚未完成模型分配测试，请联系管理员');}
 const {settings,mode}=await proposedProvider(env,userId,{});if(!allowUntested&&previous.config_hash!==await providerFingerprint(settings,mode))throw new Error('模型配置已变更，需要管理员重新测试此账号');return settings;
}
export async function providerValidated(env:Env,userId:string){try{const row=await env.DB.prepare('SELECT config_hash FROM user_providers WHERE user_id=?').bind(userId).first<{config_hash:string}>();if(!row)return false;const {settings,mode}=await proposedProvider(env,userId,{});return row.config_hash===await providerFingerprint(settings,mode);}catch{return false;}}
