import {readFileSync} from "node:fs";
import {quoteCombos} from "./quote.mjs";

try {
  const files = process.argv.slice(2);
  if (files.length !== 3) throw new Error("Usage: node cli.mjs MENU.json PROMOTIONS.json CART.json");
  const [menu, promotions, items] = files.map(path => JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")));
  console.log(JSON.stringify(quoteCombos(menu, promotions, items), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
