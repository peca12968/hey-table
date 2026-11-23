import {readFileSync} from "node:fs";
import {train, holdout} from "./snapshot.mjs";

function json(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

try {
  const [command, training, config, input, ...rest] = process.argv.slice(2);
  if (!input || rest.length || !["recommend", "evaluate"].includes(command)) {
    throw new Error("Usage: node menu-pairs.mjs recommend TRAIN.db CONFIG.json CART.json | evaluate TRAIN.db CONFIG.json LATER.db");
  }
  const trained = train(training, json(config));
  let result;
  if (command === "recommend") {
    const cart = json(input);
    if (!Array.isArray(cart.unavailable)) throw new Error("cart must specify the current unavailable dish IDs");
    result = {trainingOrders: trained.model.orders, suggestions: trained.model.rank(cart.items, cart.unavailable)};
  } else {
    result = holdout(input, trained);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
