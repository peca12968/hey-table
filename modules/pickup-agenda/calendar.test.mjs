import assert from "node:assert/strict";
import {execFileSync, spawn} from "node:child_process";
import {once} from "node:events";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {createInterface} from "node:readline";
import test from "node:test";
import ICAL from "ical.js";
import {pickupCalendar} from "../../server/pickup-calendar.mjs";

test("the Hey Table receipt file has one parseable event with a stable UID and explicit UTC end",async()=>{
  const start=Date.parse("2026-11-25T12:00:00+08:00"),created=start-3_600_000;
  const base={id:17,token:"fixture-secret",created,start,modified:created,revision:0,status:"CONFIRMED"};
  const snapshots=[base,{...base,start:start+900_000,modified:created+60_000,revision:1},
    {...base,start:start+900_000,modified:created+120_000,revision:2,status:"CANCELLED"}];
  let uid;
  for(const input of snapshots){
    const raw=await pickupCalendar(input);
    assert.ok(raw.endsWith("\r\n")&&!raw.replaceAll("\r\n","").includes("\n"));
    assert.ok(raw.split("\r\n").every(line=>Buffer.byteLength(line,"utf8")<=75));
    assert.ok(!raw.includes(input.token));
    const entries=new ICAL.Component(ICAL.parse(raw)).getAllSubcomponents("vevent");
    assert.equal(entries.length,1);
    const field=name=>entries[0].getFirstPropertyValue(name);
    uid??=field("uid");
    assert.match(uid,/^[a-f0-9]{64}@hey-table\.invalid$/);
    assert.equal(field("uid"),uid);
    assert.equal(field("summary"),"禾日食堂 · 自取 0017");
    assert.equal(field("status"),input.status);
    assert.equal(field("sequence"),input.revision);
    assert.equal(field("dtstart").toJSDate().getTime(),input.start);
    assert.equal(field("dtend").toJSDate().getTime(),input.start+900_000);
    assert.equal(field("dtstamp").toJSDate().getTime(),input.modified);
  }
  const other=new ICAL.Component(ICAL.parse(await pickupCalendar({...base,token:"other-secret"}))).getFirstSubcomponent("vevent");
  assert.notEqual(other.getFirstPropertyValue("uid"),uid);
});

test("one live subscription follows estimate, confirmation, reschedule and cancellation", {timeout:30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(),"pickup-agenda-"));
  const python = process.env.PYTHON || "python";
  const estimator = resolve(process.env.PICKUP_WINDOW || "../pickup-window");
  const db = join(dir,"local.db");
  let server, stopped;
  try {
    const estimate = execFileSync(process.execPath,[join(estimator,"cli.mjs"),"examples/stations.json",
      join(estimator,"examples/kitchen.json")]);
    assert.deepEqual(JSON.parse(estimate),JSON.parse(await readFile("examples/estimate.json","utf8")));
    const source = join(dir,"actual-estimate.json");
    await writeFile(source,estimate);
    const cli = (...args) => JSON.parse(execFileSync(python,["pickup.py",db,...args],{encoding:"utf8"}));
    const {uid} = cli("propose","demo", "17","examples/stations.json",source);
    server = spawn(python,["pickup.py",db,"serve","--port","0"],{stdio:["ignore","pipe","inherit"]});
    stopped = once(server,"exit");
    const lines = createInterface({input:server.stdout});
    const [origin] = await once(lines,"line");
    const url = origin+"/calendar/"+uid+".ics";
    async function check(sequence,status,start,end,previous) {
      const res = await fetch(url,{headers:previous ? {"If-None-Match":previous} : {}});
      assert.equal(res.status,200);
      const tag = res.headers.get("etag");
      assert.ok(tag && tag !== previous);
      const raw = await res.text();
      assert.ok(!raw.includes("fixture-private-note"));
      const entries = new ICAL.Component(ICAL.parse(raw)).getAllSubcomponents("vevent");
      assert.equal(entries.length,1);
      const field = key => entries[0].getFirstPropertyValue(key);
      assert.equal(field("uid"),uid+"@pickup-agenda.invalid");
      assert.equal(field("sequence"),sequence);
      assert.equal(field("status"),status);
      assert.equal(field("summary"),"自取餐點 #17");
      assert.equal(field("dtstart").toJSDate().toISOString(),start);
      assert.equal(field("dtend").toJSDate().toISOString(),end);
      const cached = await fetch(url,{headers:{"If-None-Match":"W/"+tag}});
      assert.equal(cached.status,304);
      assert.equal(await cached.text(),"");
      return tag;
    }
    let tag = await check(0,"TENTATIVE","2026-11-23T04:08:00.000Z","2026-11-23T04:10:00.000Z");
    cli("confirm",uid,"--expect","0","--start","2026-11-23T12:15:00+08:00","--end","2026-11-23T12:20:00+08:00");
    tag = await check(1,"CONFIRMED","2026-11-23T04:15:00.000Z","2026-11-23T04:20:00.000Z",tag);
    cli("confirm",uid,"--expect","1","--start","2026-11-23T12:25:00+08:00","--end","2026-11-23T12:30:00+08:00");
    tag = await check(2,"CONFIRMED","2026-11-23T04:25:00.000Z","2026-11-23T04:30:00.000Z",tag);
    cli("cancel",uid,"--expect","2");
    await check(3,"CANCELLED","2026-11-23T04:25:00.000Z","2026-11-23T04:30:00.000Z",tag);
    assert.equal(cli("cancel",uid,"--expect","2").sequence,3);
    const file = join(dir,"pickup.ics");
    execFileSync(python,["pickup.py",db,"export",uid,file]);
    assert.deepEqual(await readFile(file),Buffer.from(await (await fetch(url)).arrayBuffer()));
    await writeFile(file,"keep existing export");
    assert.throws(() => execFileSync(python,["pickup.py",db,"export",uid,file],{stdio:"pipe"}));
    assert.equal(await readFile(file,"utf8"),"keep existing export");
  } finally {
    if (server && server.exitCode === null) server.kill();
    if (stopped) await stopped;
    await rm(dir,{recursive:true,force:true});
  }
});
