import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { app } from './app';
import type { Env } from './env';
import { runJob } from './jobs';
export class ResearchWorkflow extends WorkflowEntrypoint<Env,{job_id:string}>{
 async run(event:WorkflowEvent<{job_id:string}>,step:WorkflowStep){
  await step.do('research',{retries:{limit:0,delay:'10 seconds'},timeout:'25 minutes'},async()=>{await runJob(this.env,event.payload.job_id);});
 }
}
export default app;
