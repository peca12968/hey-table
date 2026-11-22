import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Receipts } from "./receipts.mjs";

const database = process.env.DOCK_DB || ".dock-data/receipts.sqlite3";
await mkdir(dirname(database), { recursive: true });
const receipts = new Receipts(database);
const assets = new Map([
  ["/", ["index.html", "text/html"]], ["/desk.css", ["desk.css", "text/css"]],
  ...["desk.js", "outbox.js", "sw.js"].map(name => ["/" + name, [name, "text/javascript"]])
]);
const port = Number(process.env.PORT ?? 4186);
const host = "127.0.0.1";

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (request.headers.host !== host + ":" + server.address().port) {
      return json(response, 403, { error: "請使用伺服器顯示的本機網址" });
    }
    if (request.url === "/api/receipts" && request.method === "POST") {
      if (request.headers.origin && request.headers.origin !== "http://" + request.headers.host) {
        return json(response, 403, { error: "來源不同" });
      }
      if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
        return json(response, 415, { error: "需提供 JSON 收貨紀錄" });
      }
      const buffers = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096) return json(response, 413, { error: "收貨紀錄過大" });
        buffers.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(buffers).toString("utf8")); }
      catch { return json(response, 400, { error: "無法解析 JSON" }); }
      const { status, body } = receipts.receive(input);
      return json(response, status, body);
    }
    const asset = assets.get(request.url);
    if (asset && request.method === "GET") {
      const content = await readFile(fileURLToPath(new URL("./public/" + asset[0], import.meta.url)));
      response.writeHead(200, { "Content-Type": asset[1] + "; charset=utf-8", "Cache-Control": "no-cache" });
      return response.end(content);
    }
    json(response, 404, { error: "找不到資源" });
  } catch (error) {
    console.error(error.message);
    json(response, 500, { error: "收貨站暫時無法處理" });
  }
});
server.on("close", () => receipts.close());
server.listen(port, host, () => console.log("Dock Outbox http://" + host + ":" + server.address().port));
