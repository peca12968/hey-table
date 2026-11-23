import {readFile} from "node:fs/promises";
import {parseArgs} from "node:util";
import {estimate} from "./estimate.mjs";

try {
  const {values, positionals} = parseArgs({allowPositionals:true, options:{cart:{type:"string"}, progress:{type:"string"}}});
  if (positionals.length !== 2) throw Error("Usage: node cli.mjs SNAPSHOT.json KITCHEN.json [--cart CART.json] [--progress PROGRESS.json]");
  const read = async path => JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  const [snapshot, kitchen, cart, progress] = await Promise.all([...positionals, values.cart, values.progress].map(p => p === undefined ? undefined : read(p)));
  console.log(JSON.stringify(estimate(snapshot, kitchen, {cart, progress}), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
