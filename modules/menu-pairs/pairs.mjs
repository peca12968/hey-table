function positive(n, label) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(label + " must be a positive integer");
  return n;
}

export function dishIds(items, label) {
  if (!Array.isArray(items) || items.some(id => typeof id !== "string" || !id.trim())) {
    throw new Error(label + " must be an array of dish IDs");
  }
  return [...new Set(items)].sort();
}

export function settings(config) {
  const offers = dishIds(config.offers, "offers");
  if (!offers.length) throw new Error("offers must contain at least one add-on");
  return {offers, minPair: positive(config.minPair, "minPair"), k: positive(config.k, "k")};
}

function increment(counts, id) {
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

export class MenuPairs {
  constructor(config) {
    this.config = settings(config);
    this.offers = new Set(this.config.offers);
    this.orders = 0;
    this.frequency = new Map();
    this.pairs = new Map();
  }

  observe(basket) {
    const ids = dishIds(basket, "basket");
    if (!ids.length) throw new Error("completed order has an empty basket");
    this.orders++;
    const offers = ids.filter(id => this.offers.has(id));
    for (const id of ids) {
      increment(this.frequency, id);
      if (!this.pairs.has(id)) this.pairs.set(id, new Map());
      for (const offer of offers) {
        if (id !== offer) increment(this.pairs.get(id), offer);
      }
    }
  }

  rank(cart, unavailable = [], popularityOnly = false) {
    const anchors = dishIds(cart, "cart");
    const excluded = new Set([...anchors, ...dishIds(unavailable, "unavailable")]);
    const candidates = [];
    for (const id of this.config.offers) {
      const ordersWithOffer = this.frequency.get(id) ?? 0;
      if (excluded.has(id) || !ordersWithOffer) continue;
      const prior = ordersWithOffer / this.orders;
      let evidence = null;
      for (const anchor of popularityOnly ? [] : anchors) {
        const together = this.pairs.get(anchor)?.get(id) ?? 0;
        if (together < this.config.minPair) continue;
        const ordersWithAnchor = this.frequency.get(anchor);
        const score = (together + 2 * prior) / (ordersWithAnchor + 2);
        if (!evidence || score > evidence.score) evidence = {anchor, together, ordersWithAnchor, score};
      }
      candidates.push({id, ordersWithOffer, score: evidence?.score ?? prior, evidence});
    }
    candidates.sort((a, b) => b.score - a.score || b.ordersWithOffer - a.ordersWithOffer ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return candidates.slice(0, this.config.k);
  }
}

export function evaluate(model, baskets) {
  const result = {trainingOrders: model.orders, k: model.config.k, completedOrders: 0, evaluated: 0,
    noAnchor: 0, withoutAddOn: 0, recommendationHits: 0, popularityHits: 0,
    paired: {bothHit: 0, recommendationOnly: 0, popularityOnly: 0, bothMiss: 0}};
  for (const basket of baskets) {
    const ids = dishIds(basket, "basket");
    result.completedOrders++;
    const cart = ids.filter(id => !model.offers.has(id));
    if (!cart.length) {
      result.noAnchor++;
      continue;
    }
    const bought = new Set(ids.filter(id => model.offers.has(id)));
    result.evaluated++;
    if (!bought.size) result.withoutAddOn++;
    const hit = model.rank(cart).some(row => bought.has(row.id));
    const baseline = model.rank(cart, [], true).some(row => bought.has(row.id));
    if (hit) result.recommendationHits++;
    if (baseline) result.popularityHits++;
    if (hit && baseline) result.paired.bothHit++;
    else if (hit) result.paired.recommendationOnly++;
    else if (baseline) result.paired.popularityOnly++;
    else result.paired.bothMiss++;
  }
  return result;
}
