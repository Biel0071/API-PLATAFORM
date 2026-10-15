// Run inside the tested API container; removes only exact audit runs supplied as arguments.
const {PrismaClient}=require(require.resolve('@prisma/client',{paths:[process.cwd()]}));
const tags=process.argv.slice(2);if(!tags.length||tags.some(t=>!/^QA-AUDIT-\d{13}$/.test(t)))throw new Error('Exact QA run tags required');
const db=new PrismaClient();
(async()=>{const results=[];for(const tag of tags){
const tenant=await db.tenant.findMany({where:{name:tag,slug:tag.toLowerCase()},select:{id:true}});const tenantIds=tenant.map(t=>t.id);
const keyWhere={OR:[{name:{startsWith:tag}},...(tenantIds.length?[{tenantId:{in:tenantIds}}]:[])]};
const keys=await db.apiKey.findMany({where:keyWhere,select:{id:true,active:true}});if(keys.some(k=>k.active))throw new Error('Revoke QA keys before cleanup');
const removed=await db.$transaction(async(tx)=>({
keys:await tx.apiKey.deleteMany({where:keyWhere}),
prompts:await tx.prompt.deleteMany({where:{name:tag}}),
workflows:await tx.imageWorkflow.deleteMany({where:{name:{startsWith:tag}}}),
models:await tx.modelConfig.deleteMany({where:{modelId:tag}}),
users:await tx.user.deleteMany({where:{email:tag.toLowerCase()+'@example.test'}}),
tenants:await tx.tenant.deleteMany({where:{id:{in:tenantIds}}}),
}));results.push({tag,removed});}console.log(JSON.stringify(results,null,2));})().finally(()=>db.$disconnect());
