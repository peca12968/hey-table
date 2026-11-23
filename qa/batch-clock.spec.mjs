import {test,expect} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {tmpdir} from "node:os";

const endpoint="/api/kitchen/timing", headers={Authorization:"Bearer local-test-kitchen"};
const read=async api=>(await api.get(endpoint,{headers})).json();
const patch=(api,revision,kitchen)=>api.patch(endpoint,{headers,data:{revision,kitchen}});
const tea=async api=>(await api.post("/api/quote",{data:{items:[{id:"sencha",qty:3}]}})).json();

test("staff compare a Batch Clock export, activate it and restore while stale writers are blocked",async({browser,page,request})=>{
  const clock=process.env.BATCH_CLOCK_PROJECT||fileURLToPath(new URL("../../batch-clock/",import.meta.url));
  const dir=await mkdtemp(join(tmpdir(),"hey-table-timing-"));
  const kitchen=join(dir,"download.json"), model=join(dir,"measured.json");
  const other=await browser.newContext();
  const second=await other.newPage();
  async function manage(p){
    await p.goto("/kitchen");
    await p.evaluate(()=>sessionStorage.setItem("he-ri-staff","local-test-kitchen"));
    await p.reload();
    await p.getByRole("button",{name:"管理出餐工時"}).click();
    await expect(p.getByRole("table",{name:"目前工時"})).toBeVisible();
  }
  try {
    await manage(page);await manage(second);
    const initial=await read(request);
    const download=page.waitForEvent("download");
    await page.getByRole("button",{name:"下載目前工時"}).click();
    await (await download).saveAs(kitchen);
    const python=process.env.PYTHON||(process.platform==="win32"?"python":"python3");
    const args=[join(clock,"batch_clock.py"),"--db",join(dir,"shift.db")];
    execFileSync(python,[...args,"import",join(clock,"examples","tea.jsonl"),"--kitchen",kitchen]);
    const bytes=execFileSync(python,[...args,"calibrate","--kitchen",kitchen,"--cutoff","2026-11-23T00:00:00+08:00","--format","kitchen"]);
    await writeFile(model,bytes);
    await page.getByLabel("匯入工時 JSON").setInputFiles(model);
    const diff=page.getByRole("table",{name:"工時差異"});
    await expect(diff.getByRole("row")).toHaveCount(2);
    await expect(diff).toContainText("60–90 秒");await expect(diff).toContainText("48–85 秒");
    expect((await tea(request)).seconds).toEqual([120,180]);
    const alternate=JSON.parse(bytes.toString("utf8"));alternate.recipes.sencha.seconds=[35,41];
    await second.getByLabel("匯入工時 JSON").setInputFiles({name:"alternative.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify(alternate))});
    await page.getByRole("button",{name:"套用工時"}).click();
    await expect(page.getByText(/已套用，新的購物車/)).toBeVisible();
    const updated=await read(request);expect(updated.current.revision).toBe(initial.current.revision+1);
    expect(updated.previous).toEqual(initial.current);
    expect(await tea(request)).toMatchObject({seconds:[96,170],timingSource:"store"});
    const guest=await browser.newPage();
    try{
      await guest.goto("/");await guest.getByRole("button",{name:"加入日式熱煎茶",exact:true}).click();
      await expect(guest.getByRole("region",{name:"預估出餐時間"})).toContainText("店家設定工時");
    }finally{await guest.close();}
    await second.getByRole("button",{name:"套用工時"}).click();
    await expect(second.getByRole("status")).toContainText("其他店員更新");
    await expect(second.getByRole("button",{name:"套用工時"})).toBeDisabled();
    await second.getByRole("button",{name:"載入最新工時"}).click();
    await expect(second.getByRole("table",{name:"目前工時"})).toContainText("48–85 秒");
    await second.getByRole("button",{name:"預覽上一版"}).click();
    await second.getByRole("button",{name:"套用工時"}).click();
    await expect(second.getByText(/已套用，新的購物車/)).toBeVisible();
    expect((await tea(request)).seconds).toEqual([120,180]);
    expect((await tea(request)).timingSource).toBeUndefined();
  } finally {
    await other.close();await rm(dir,{recursive:true,force:true});
  }
});

test("staff-only timing changes validate topology, preserve revisions on no-op, and commit one concurrent writer",async({request,browser})=>{
  const {current}=await read(request),{revision,kitchen}=current;
  const guest=await browser.newContext();
  try{
    expect((await guest.request.get(endpoint)).status()).toBe(403);
    expect((await guest.request.patch(endpoint,{data:{revision,kitchen}})).status()).toBe(403);
  }finally{await guest.close();}
  for(const change of [k=>delete k.recipes.sencha,k=>k.stations.hot=99,k=>k.recipes.sencha.batchSize=9,
    k=>k.recipes.sencha.station="cold",k=>k.recipes.sencha.seconds=[80,40],k=>k.recipes.sencha.seconds=[0,4]]){
    const bad=structuredClone(kitchen);change(bad);
    const response=await patch(request,revision,bad);
    expect(response.status(),await response.text()).toBe(400);
  }
  const same=await patch(request,revision,kitchen);
  expect(await same.json()).toEqual(current);
  const responses=await Promise.all([[40,60],[55,65]].map(seconds=>{
    const candidate=structuredClone(kitchen);candidate.recipes.sencha.seconds=seconds;
    return patch(request,revision,candidate);
  }));
  expect(responses.map(r=>r.status()).sort()).toEqual([200,409]);
  const winner=await responses.find(r=>r.status()===200).json();
  expect((await read(request)).current).toEqual(winner);
  expect((await patch(request,winner.revision,kitchen)).status()).toBe(200);
});
