import { serve } from '@hono/node-server';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync,existsSync,writeFileSync,readFileSync } from 'node:fs';
import { resolve,extname,join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SqliteD1 } from './database';
import { app } from '../worker/app';
import { runJob } from '../worker/jobs';
import type { Env } from '../worker/env';
import { pinnedPublicFetch } from './public-fetch';

const root=process.cwd(),data=resolve(process.env.DATA_DIR||'.local/data');mkdirSync(data,{recursive:true});
const secretFile=join(data,'server-secrets.json');
const newSecret=()=>Array.from(randomBytes(32),n=>n.toString(16).padStart(2,'0')).join('');
if(!existsSync(secretFile))writeFileSync(secretFile,JSON.stringify({encryption:newSecret(),bootstrap:newSecret()}),{mode:0o600});
const localSecrets=JSON.parse(readFileSync(secretFile,'utf8'));
const db=new SqliteD1(join(data,'customers.sqlite'),join(root,'migrations'));
const cancelled=new Set<string>();let running=0;
const queue:string[]=[];
const execute=()=>{while(running<2&&queue.length){const jobId=queue.shift()!;if(cancelled.has(jobId))continue;running++;runJob(env,jobId).catch(()=>{}).finally(()=>{running--;execute();});}};
const env:Env={DB:db as unknown as D1Database,APP_NAME:'客户背调工作台',APP_ORIGIN:process.env.APP_ORIGIN,DEFAULT_API_URL:process.env.API_URL||'https://once.novai.su',DEFAULT_MODEL:process.env.MODEL||'[次-流抗截]gemini-3.1-pro-preview',ALTERNATE_MODEL:process.env.ALTERNATE_MODEL||'[次]claude-opus-5',API_KEY:process.env.API_KEY,ENCRYPTION_KEY:process.env.ENCRYPTION_KEY||localSecrets.encryption,BOOTSTRAP_TOKEN:process.env.BOOTSTRAP_TOKEN||localSecrets.bootstrap,SEARCH_API_KEY:process.env.SEARCH_API_KEY,
 RESEARCH:{async create(options:any){queue.push(options.params.job_id);setTimeout(execute,0);return {id:options.id};},async get(jobId:string){return {async terminate(){cancelled.add(jobId);}};}} as unknown as Workflow,
 ASSETS:{async fetch(request:Request){const path=decodeURIComponent(new URL(request.url).pathname),base=resolve(root,'dist');let target=resolve(base,'.'+path);if(!target.startsWith(base+ '/')&&!target.startsWith(base+'\\')&&target!==base)return new Response('Not found',{status:404});try{if((await stat(target)).isDirectory())target=join(target,'index.html');await stat(target);}catch{target=join(base,'index.html');}try{const body=await readFile(target);const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};return new Response(body,{headers:{'Content-Type':mime[extname(target)]||'application/octet-stream','Cache-Control':extname(target)==='.html'?'no-cache':'public,max-age=3600','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"}});}catch{return new Response('Frontend not built. Run npm run build.',{status:503});}}} as unknown as Fetcher};
(env as any).PUBLIC_FETCH=pinnedPublicFetch;
// Resume queued tasks; running jobs are explicitly failed after a process restart to avoid duplicate paid requests.
await db.prepare("UPDATE jobs SET status='failed',stage='服务重启，任务已中断',error='服务在执行中重启，请检查结果后手动重试',updated_at=? WHERE status='running'").bind(new Date().toISOString()).run();
const pending=await db.prepare("SELECT id FROM jobs WHERE status='queued' ORDER BY created_at").all<{id:string}>();queue.push(...pending.results.map(x=>x.id));execute();
const port=Number(process.env.PORT)||8787;
serve({port,hostname:process.env.HOST||'127.0.0.1',fetch:request=>app.fetch(request,env)},()=>console.log(`CustomerBackground listening on port ${port}; database persistent; setup token stored privately in data/server-secrets.json`));
