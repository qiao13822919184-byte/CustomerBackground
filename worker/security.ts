const encoder = new TextEncoder();
export function randomToken(bytes = 32) { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''); }
export async function sha256(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
export function constantEqual(a: string, b: string) { const x=encoder.encode(a),y=encoder.encode(b); let d=x.length^y.length; for(let i=0;i<Math.max(x.length,y.length);i++) d|=(x[i]||0)^(y[i]||0); return d===0; }
export async function hashPassword(password: string, salt = randomToken(16)) {
  const key = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'},key,256);
  return `pbkdf2:100000:${salt}:${btoa(String.fromCharCode(...new Uint8Array(bits)))}`;
}
export async function verifyPassword(password:string, stored:string) { const p=stored.split(':'); return p.length===4 && constantEqual(await hashPassword(password,p[2]),stored); }
async function encryptionKey(secret:string) {
  if (!secret || secret.length<32) throw new Error('服务端 ENCRYPTION_KEY 未配置');
  return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode(secret)),'AES-GCM',false,['encrypt','decrypt']);
}
export async function encryptSecret(value:string,secret:string) { const iv=crypto.getRandomValues(new Uint8Array(12));const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},await encryptionKey(secret),encoder.encode(value));return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`; }
export async function decryptSecret(value:string,secret:string) { const [iv,body]=value.split('.');return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:Uint8Array.from(atob(iv),c=>c.charCodeAt(0))},await encryptionKey(secret),Uint8Array.from(atob(body),c=>c.charCodeAt(0)))); }
export function passwordValid(v:unknown):v is string {return typeof v==='string'&&v.length>=12&&v.length<=128;}
export function publicHttps(value:string) { let u:URL; try{u=new URL(value);}catch{throw new Error('请输入有效的 HTTPS API 地址');} const h=u.hostname.toLowerCase(); if(u.protocol!=='https:'||u.username||u.password||u.hash||u.search||h==='localhost'||h.endsWith('.local')||h.endsWith('.internal')||h.startsWith('[')||/^\d+(\.\d+){3}$/.test(h)||!h.includes('.'))throw new Error('API 地址必须为公网 HTTPS 域名');return u.toString().replace(/\/$/,''); }
