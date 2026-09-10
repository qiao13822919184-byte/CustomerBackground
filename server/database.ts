import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
class Statement {
 constructor(private db:DatabaseSync,private sql:string,private args:any[]=[]){}
 bind(...args:any[]){return new Statement(this.db,this.sql,args);}
 async first<T>(column?:string):Promise<T|null>{const r=this.db.prepare(this.sql).get(...this.args) as any;return r?(column?r[column]:r):null;}
 async all<T>(){const results=this.db.prepare(this.sql).all(...this.args) as T[];return {success:true,results,meta:{changes:0}};}
 async run(){const r=this.db.prepare(this.sql).run(...this.args);return {success:true,results:[],meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
 async raw(){return this.db.prepare(this.sql).all(...this.args).map(r=>Object.values(r));}
 execute(){const stmt=this.db.prepare(this.sql);if(/^\s*(SELECT|PRAGMA)/i.test(this.sql))return {success:true,results:stmt.all(...this.args),meta:{changes:0}};const r=stmt.run(...this.args);return {success:true,results:[],meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}};}
}
export class SqliteD1 {
 readonly db:DatabaseSync;
 constructor(path:string,migrationsDir:string){mkdirSync(dirname(path),{recursive:true});this.db=new DatabaseSync(path);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');this.db.exec('CREATE TABLE IF NOT EXISTS app_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');for(const f of readdirSync(migrationsDir).filter(f=>f.endsWith('.sql')).sort()){if(this.db.prepare('SELECT name FROM app_migrations WHERE name=?').get(f))continue;this.db.exec('BEGIN IMMEDIATE');try{this.db.exec(readFileSync(join(migrationsDir,f),'utf8'));this.db.prepare('INSERT INTO app_migrations VALUES(?,?)').run(f,new Date().toISOString());this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}}
 prepare(sql:string){return new Statement(this.db,sql);}
 async batch(statements:Statement[]){this.db.exec('BEGIN IMMEDIATE');try{const results=statements.map(s=>s.execute());this.db.exec('COMMIT');return results;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 async exec(sql:string){this.db.exec(sql);return {count:1,duration:0};}
}
