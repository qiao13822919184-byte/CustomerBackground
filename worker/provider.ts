import type { Env } from './env';
import type { ProviderSettings } from '../shared/types';
import { decryptSecret } from './security';
export interface PrivateProvider extends ProviderSettings { api_key:string; search_api_key?:string; public_fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; }
export async function getProvider(env:Env):Promise<PrivateProvider> {
 const rows=await env.DB.prepare('SELECT id,value FROM settings').all<{id:string,value:string}>(); const s=Object.fromEntries(rows.results.map(r=>[r.id,r.value]));
 const api_key=s.api_key?await decryptSecret(s.api_key,env.ENCRYPTION_KEY):(env.API_KEY||'');
 const search_api_key=s.search_api_key?await decryptSecret(s.search_api_key,env.ENCRYPTION_KEY):env.SEARCH_API_KEY;
 return {api_url:s.api_url||env.DEFAULT_API_URL,model:s.model||env.DEFAULT_MODEL,alternate_model:s.alternate_model||env.ALTERNATE_MODEL,api_key,search_api_key,public_fetch:env.PUBLIC_FETCH,key_configured:!!api_key,search_key_configured:!!search_api_key,search_provider:s.search_provider==='brave'?'brave':'bing',max_steps:Math.max(3,Math.min(10,Number(s.max_steps)||10))};
}
