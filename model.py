"""Inventory oracle. Each reserved unit has its own disposition."""
from dataclasses import dataclass, field
import random
import re


@dataclass
class Hold:
    units: list
    expires: int
    state: str = "held"
    receipts: dict = field(default_factory=dict)

    def close(self, state):
        self.units = ["released" if unit == "held" else unit for unit in self.units]
        self.state = state


class Model:
    def __init__(self):
        self.now = 100
        self.holds = {}

    def stock(self):
        units = [unit for hold in self.holds.values() for unit in hold.units]
        capacity = 20 - units.count("shipped")
        return {"sku": "KIT-01", "capacity": capacity, "available": capacity - units.count("held")}

    def view(self, key, progress=False):
        hold = self.holds[key]
        result = {"id": key, "sku": "KIT-01", "quantity": len(hold.units), "state": hold.state,
                  "expires_at_ms": hold.expires}
        if progress:
            result.update(held=hold.units.count("held"), shipped=hold.units.count("shipped"),
                          returned=hold.units.count("released"))
        return result

    def apply(self, action):
        op = action["op"]
        if op == "advance":
            self.now += action["seconds"]
            for hold in self.holds.values():
                if hold.state == "held" and hold.expires <= self.now * 1000:
                    hold.close("expired")
            return None
        if op == "restart":
            return None
        key = action["key"]
        hold = self.holds.get(key)
        if op == "reserve":
            qty = action["qty"]
            if hold:
                return (200, self.view(key)) if qty == len(hold.units) else (409, None)
            if qty > self.stock()["available"]:
                return 409, None
            self.holds[key] = Hold(["held"] * qty, (self.now + 5) * 1000)
            return 201, self.view(key)
        if not hold:
            return 404, None
        if op == "cancel":
            if hold.state == "held":
                hold.close("released")
            return 200, self.view(key)
        receipt_key = op, action["receipt"]
        prior = hold.receipts.get(receipt_key)
        if prior:
            return (200, prior[1]) if action == prior[0] else (409, None)
        if hold.state != "held":
            return 409, None
        result = {"reservation_id": key}
        if op == "renew":
            if action["expected"] != hold.expires:
                return 409, None
            result.update(renewal_id=action["receipt"], previous_expires_at_ms=hold.expires)
            hold.expires += action["seconds"] * 1000
            result.update(expires_at_ms=hold.expires)
        else:
            qty = action["qty"]
            remaining = [i for i, unit in enumerate(hold.units) if unit == "held"]
            if len(remaining) < qty:
                return 409, None
            for index in remaining[:qty]:
                hold.units[index] = "shipped" if op == "ship" else "released"
            if "held" not in hold.units:
                hold.state = "released" if "released" in hold.units else "fulfilled"
            receipt_field = "shipment_id" if op == "ship" else "release_id"
            result.update({receipt_field: action["receipt"], "quantity": qty, "held_after": len(remaining) - qty})
        hold.receipts[receipt_key] = action.copy(), result
        return 201, result


def generate(seed, steps):
    rng = random.Random(seed)
    model = Model()
    actions = []
    for _ in range(steps):
        active = [k for k, h in model.holds.items() if h.state == "held"]
        key = rng.choice(active) if active and rng.random() < 0.8 else f"r{rng.randrange(12)}"
        op = rng.choice(["reserve", "reserve", "ship", "release", "renew", "advance", "cancel", "restart"])
        if not active and rng.random() < 0.7:
            op = "reserve"
        if actions and rng.random() < 0.16:
            action = rng.choice(actions).copy()
        elif op == "advance":
            action = {"op": op, "seconds": rng.choice([1, 4, 5, 10])}
        elif op == "restart":
            action = {"op": op}
        elif op == "cancel":
            action = {"op": op, "key": key}
        elif op == "renew":
            hold = model.holds.get(key)
            deadline = hold.expires if hold and rng.random() < 0.85 else model.now * 1000
            action = {"op": op, "key": key, "expected": deadline, "seconds": rng.randint(1, 8),
                      "receipt": f"k{rng.randrange(3)}"}
        else:
            action = {"op": op, "key": key, "qty": rng.randint(1, 8 if op == "reserve" else 4)}
            if op != "reserve":
                action["receipt"] = f"k{rng.randrange(3)}"
        model.apply(action)
        actions.append(action)
    return actions


FIELDS = {"advance": ("seconds",), "restart": (), "cancel": ("key",), "reserve": ("key", "qty"),
          "ship": ("key", "qty", "receipt"), "release": ("key", "qty", "receipt"),
          "renew": ("key", "receipt", "expected", "seconds")}


def validate(actions):
    if not isinstance(actions, list):
        raise ValueError("expected an array of actions")
    for i, action in enumerate(actions, 1):
        if not isinstance(action, dict) or not isinstance(action.get("op"), str) or action["op"] not in FIELDS:
            raise ValueError(f"step {i}: unknown operation")
        fields = FIELDS[action["op"]]
        if set(action) != {"op", *fields}:
            raise ValueError(f"step {i}: expected fields {fields}")
        for name in fields:
            value = action[name]
            if name in ("key", "receipt"):
                valid = isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", value)
            else:
                low, high = {"seconds": (1, 86400), "qty": (1, 1_000_000), "expected": (0, 2**63-1)}[name]
                valid = type(value) is int and low <= value <= high
            if not valid:
                raise ValueError(f"step {i}: invalid {name}")
