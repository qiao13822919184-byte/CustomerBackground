import type { Env } from './env';
import type { Lead, User } from '../shared/types';
export const now=()=>new Date().toISOString();
export const id=()=>crypto.randomUUID();
export const parseLead=(r:Record<string,unknown>)=>({...r,raw:typeof r.raw==='string'?JSON.parse(r.raw):r.raw}) as unknown as Lead;
export const safeUser=(r:Record<string,unknown>)=>{const {password_hash,...user}=r;return user as unknown as User;};
export async function audit(env:Env,workspace:string|null,user:string|null,action:string,kind:string,entity:string,details:unknown={}) {await env.DB.prepare('INSERT INTO audit_events(id,workspace_id,user_id,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id(),workspace,user,action,kind,entity,JSON.stringify(details),now()).run();}
export async function canAccess(env:Env,user:User,workspace:string) {if(user.role==='admin')return !!await env.DB.prepare('SELECT id FROM workspaces WHERE id=?').bind(workspace).first();return !!await env.DB.prepare('SELECT user_id FROM memberships WHERE workspace_id=? AND user_id=?').bind(workspace,user.id).first();}
