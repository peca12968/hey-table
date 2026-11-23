// Render the pinned restaurant's /tables page and QR endpoint entirely on this machine.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";

if (process.argv.length !== 4) throw Error("Usage: node capture.mjs PATH_TO_BUILT_HEY_TABLE NEW_OUTPUT_DIR");
const site=resolve(process.argv[2]), out=resolve(process.argv[3]);
const {Miniflare}=createRequire(join(site,"package.json"))("miniflare");
const {chromium}=createRequire(join(site,"qa","package.json"))("@playwright/test");
const root=join(site,"dist","server");
const config=JSON.parse(await readFile(join(root,"wrangler.json"),"utf8"));
const scripts=(await readdir(root,{recursive:true})).filter(name=>name.endsWith(".js") && name!==config.main);
const app=new Miniflare({modulesRoot:root,modules:[config.main,...scripts].map(name=>({type:"ESModule",path:join(root,name)})),
  compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
  assets:{directory:resolve(root,config.assets.directory),routerConfig:{has_user_worker:true}}});
const manifest=JSON.parse(await readFile(new URL("./examples/manifest.json",import.meta.url),"utf8"));
const origin=new URL(manifest.cards[0].expected).origin;
let browser;
try {
  browser=await chromium.launch();
  const context=await browser.newContext({deviceScaleFactor:2});
  await context.route("**/*",async route=>{
    const url=route.request().url();
    if(new URL(url).origin!==origin) return route.abort();
    const response=await app.dispatchFetch(url);
    await route.fulfill({status:response.status,contentType:response.headers.get("content-type")||"application/octet-stream",
      body:Buffer.from(await response.arrayBuffer())});
  });
  const page=await context.newPage();
  await page.emulateMedia({media:"print"});
  const response=await page.goto(origin+"/tables");
  assert.equal(response.status(),200);
  const cards=page.locator(".qrCard");
  assert.equal(await cards.count(),manifest.cards.length);
  const images=[];
  for(const entry of manifest.cards){
    const card=cards.filter({has:page.getByRole("heading",{name:entry.table+" 桌",exact:true})});
    assert.equal(await card.count(),1);
    assert.equal(await card.locator("a").evaluate(a=>a.href),entry.expected);
    const qr=card.getByRole("img",{name:entry.table+" 桌點餐 QR Code",exact:true});
    await qr.evaluate(img=>img.decode());
    images.push(await qr.screenshot());
  }
  await mkdir(out);
  for(const [i,entry] of manifest.cards.entries()) await writeFile(join(out,entry.image),images[i]);
  await writeFile(join(out,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
  console.log("Captured "+images.length+" printed QR regions from the local restaurant Worker.");
} finally {
  await browser?.close();
  await app.dispose();
}
