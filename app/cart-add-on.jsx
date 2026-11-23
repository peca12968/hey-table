"use client";
import {useEffect, useState} from "react";
import {Plus} from "lucide-react";
import {dishes} from "../lib/menu.mjs";
import {request} from "./shared";

const labels = {menu: "菜單搭配", pair: "常一起點", popular: "人氣加點"};

export default function CartAddOn({body, sold, onAdd}) {
  const [suggestion, setSuggestion] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const result = await request("/api/add-on", {method: "POST", signal: controller.signal,
          headers: {"Content-Type": "application/json"}, body});
        if (!controller.signal.aborted) setSuggestion(result.suggestion);
      } catch {
        // Recommendations are optional. Ordering remains available during a lookup failure.
      }
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [body]);
  const dish = dishes.find(d => d.id === suggestion?.id);
  if (!dish || sold.includes(dish.id)) return null;
  return <section className="cartAddOn" aria-label="搭配加點">
    <img src={"/food/" + dish.id + ".webp"} alt="" width="48" height="48"/>
    <div><small>{labels[suggestion.source]}</small><b>{dish.name}</b></div>
    <button type="button" aria-label={"加點" + dish.name + "，NT$ " + dish.price}
      onClick={() => onAdd(dish.id)}><Plus size={15} aria-hidden="true"/> NT$ {dish.price}</button>
  </section>;
}
