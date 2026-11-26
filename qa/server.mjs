import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawn,execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {handoffCashFixture} from "./shift-handoff-fixture.mjs";
const root=fileURLToPath(new URL("../",import.meta.url));
const state=mkdtempSync(join(tmpdir(),"hey-table-"));
const wrangler=["--import","./scripts/sites-env.mjs","./node_modules/wrangler/bin/wrangler.js"];
const common=["--local","--config","dist/server/wrangler.json","--persist-to",state];
const journal=JSON.parse(readFileSync(join(root,"drizzle/meta/_journal.json"),"utf8"));
const migrations=journal.entries.map(({tag})=>readFileSync(join(root,"drizzle",tag+".sql"),"utf8"));
const {date,token,note}=handoffCashFixture;
// Use a separate business day so the worklist preview is independent of earlier browser tests.
const handoffCash=`INSERT INTO orders(token,mode,status,items,note,total,created)
  VALUES ('${token}','pickup','completed','[{"id":"sencha","name":"日式熱煎茶","price":45,"qty":1}]',
    '${note}',45,${Date.parse(date+"T11:30:00+08:00")});`;
const setup=join(state,"setup.sql");
writeFileSync(setup,[...migrations,handoffCash].join("\n"));
execFileSync(process.execPath,[...wrangler,"d1","execute","DB",...common,"--file",setup],{cwd:root});
const child=spawn(process.execPath,[...wrangler,"dev",...common,"--ip","127.0.0.1","--port","18841",
  "--inspector-port","0","--var","STAFF_KEY:local-test-kitchen"],{cwd:root,stdio:"inherit"});
for(const signal of ["SIGTERM","SIGINT"]) process.on(signal,()=>child.kill());
child.on("exit",code=>{try{rmSync(state,{force:true,recursive:true,maxRetries:4});}finally{process.exitCode=code??0;}});
