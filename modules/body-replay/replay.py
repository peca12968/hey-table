"""Compare a weighted corpus of JSON request bodies against two OpenAPI 3.1 contracts."""
import argparse
import json
from pathlib import Path
import re
import sys
from urllib.parse import quote, unquote

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from referencing import Registry
from referencing.jsonschema import DRAFT202012


ROOT = "urn:body-replay:document"
DIALECT = "https://json-schema.org/draft/2020-12/schema"
OAS = "https://spec.openapis.org/oas/3.1/dialect/base"
METHODS = {"get", "put", "post", "delete", "options", "head", "patch", "trace"}
PARAM = re.compile(r"\{[^/{}]+\}")


def read_json(path):
    def unique_pairs(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f"{path}: duplicate object key {key!r}")
            value[key] = item
        return value

    def invalid_number(value):
        raise ValueError(f"{path}: invalid JSON number {value}")

    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=unique_pairs,
                      parse_constant=invalid_number)


def pointer(parts):
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in parts)


def lookup(document, ref):
    if not isinstance(ref, str) or not ref.startswith("#/"):
        raise ValueError(f"expected a document-local JSON Pointer, got {ref!r}")
    node = document
    for part in unquote(ref[2:]).split("/"):
        if re.search(r"~(?![01])", part):
            raise ValueError(f"invalid escape in reference {ref}")
        key = part.replace("~1", "/").replace("~0", "~")
        if isinstance(node, dict) and key in node:
            node = node[key]
        elif isinstance(node, list) and re.fullmatch(r"0|[1-9][0-9]*", key) and int(key) < len(node):
            node = node[int(key)]
        else:
            raise ValueError(f"unresolved reference {ref}")
    return node


def route_regex(path):
    pieces = []
    end = 0
    for match in PARAM.finditer(path):
        pieces.extend((re.escape(path[end:match.start()]), "[^/]+"))
        end = match.end()
    return re.compile("".join(pieces) + re.escape(path[end:]))


class Contract:
    def __init__(self, doc):
        if (not isinstance(doc, dict) or not re.fullmatch(r"3\.1\.\d+", str(doc.get("openapi")))
                or not isinstance(doc.get("paths"), dict)):
            raise ValueError("expected an OpenAPI 3.1 document with paths")
        if doc.get("jsonSchemaDialect", OAS) not in (OAS, DIALECT):
            raise ValueError("unsupported default JSON Schema dialect")
        self.doc = doc
        self.routes = {}
        self.operations = {}
        self.validators = {}
        self.registry = Registry().with_resource(ROOT, DRAFT202012.create_resource(doc))
        for path, item in doc["paths"].items():
            if path.startswith("x-"):
                continue
            if not path.startswith("/") or not isinstance(item, dict) or "$ref" in item:
                raise ValueError("expected inline path items")
            self.routes[path] = route_regex(path)
            for method in item.keys() & METHODS:
                self.operations[method, path] = item[method]

    def body_operations(self):
        return {f"{m.upper()} {p}" for (m,p), op in self.operations.items() if "requestBody" in op}

    def resolve_body(self, operation, location):
        body = operation["requestBody"]
        seen = set()
        while isinstance(body, dict) and "$ref" in body:
            ref = body["$ref"]
            if ref in seen:
                raise ValueError("cyclic reference to a requestBody")
            seen.add(ref)
            body = lookup(self.doc, ref)
            location = unquote(ref[1:])
        if not isinstance(body, dict) or not isinstance(body.get("content"), dict):
            raise ValueError("invalid requestBody object")
        return body, location

    def validator(self, schema, key):
        if key not in self.validators:
            pending = [schema]
            seen = set()
            while pending:
                node = pending.pop()
                if id(node) in seen:
                    continue
                seen.add(id(node))
                Draft202012Validator.check_schema(node)
                if isinstance(node, dict):
                    if node.get("$schema", DIALECT) != DIALECT or node.keys() & {
                            "$id", "$anchor", "$dynamicAnchor", "$dynamicRef", "$vocabulary"}:
                        raise ValueError("unsupported embedded schema dialect, resource or anchor")
                    if "$ref" in node:
                        pending.append(lookup(self.doc, node["$ref"]))
                    pending.extend(DRAFT202012.subresources_of(node))
            # Anchor local references to the OpenAPI document, not the inline schema.
            self.validators[key] = Draft202012Validator({"$ref": ROOT+"#"+quote(key, safe="/~")},
                                                       registry=self.registry)
        return self.validators[key]

    def inspect(self, case):
        path, method = case["path"], case["method"].lower()
        if path not in self.routes:
            matches = [name for name, regex in self.routes.items() if regex.fullmatch(path)]
            if len(matches) > 1:
                raise ValueError(f"ambiguous path templates for {path}")
            path = matches[0] if matches else None
        operation = self.operations.get((method, path))
        if operation is None:
            return None, [{"rule":"operation_missing"}]
        label = f"{method.upper()} {path}"
        if "requestBody" not in operation:
            return label, [{"rule":"body_undocumented"}] if "body" in case else []
        body, location = self.resolve_body(operation, pointer(("paths",path,method,"requestBody")))
        if "body" not in case:
            return label, [{"rule":"body_required"}] if body.get("required") else []
        media = body["content"]
        mime = next((value for value in ("application/json", "application/*", "*/*") if value in media), None)
        if mime is None:
            return label, [{"rule":"json_undocumented"}]
        if not isinstance(media[mime], dict):
            raise ValueError("invalid media type object")
        if "schema" not in media[mime]:
            return label, []
        schema = media[mime]["schema"]
        validator = self.validator(schema, location+pointer(("content",mime,"schema")))
        errors = [{"pointer":pointer(e.absolute_path), "rule":e.validator or "falseSchema", "message":e.message}
                  for e in validator.iter_errors(case["body"])]
        return label, sorted(errors, key=lambda e:(e["pointer"],e["rule"],e["message"]))


def compare(before, after, cases):
    old, new = Contract(before), Contract(after)
    if not isinstance(cases, list) or not cases:
        raise ValueError("provide a nonempty JSON array of request examples")
    totals = {"preserved":0, "regressed":0, "baselineRejected":0}
    findings, seen, covered = [], set(), set()
    for case in cases:
        if not isinstance(case, dict) or case.keys() - {"id","method","path","body","count"}:
            raise ValueError("invalid request example fields")
        key, path = case.get("id"), case.get("path")
        if not isinstance(key, str) or not key.strip() or key in seen:
            raise ValueError("request IDs must be nonempty and unique")
        seen.add(key)
        if (not isinstance(path,str) or not path.startswith("/") or any(c in path for c in "?#{}")
                or not isinstance(case.get("method"),str) or case["method"].lower() not in METHODS):
            raise ValueError(f"{key}: expected a concrete path and HTTP method")
        count = case.get("count",1)
        if type(count) is not int or count < 1:
            raise ValueError(f"{key}: count must be a positive integer")
        _, issues = old.inspect(case)
        if issues:
            status = "baselineRejected"
        else:
            operation, issues = new.inspect(case)
            covered.add(operation)
            status = "regressed" if issues else "preserved"
        totals[status] += count
        if issues:
            findings.append({"id":key,"status":status,"count":count,"issues":issues,
                             "request":{k:case[k] for k in ("method","path","body") if k in case}})
    return {"examples":len(cases), "requests":sum(totals.values()), "counts":totals, "findings":findings,
            "uncoveredCandidateBodyOperations":sorted(new.body_operations()-covered)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("before","after","corpus"):
        parser.add_argument(field,type=Path)
    args = parser.parse_args()
    try:
        report = compare(*(read_json(p) for p in (args.before,args.after,args.corpus)))
    except (ValueError, OSError, TypeError, AttributeError, KeyError, SchemaError, RecursionError) as exc:
        parser.exit(2, f"body-replay: {exc}\n")
    print(json.dumps(report, ensure_ascii=True, indent=2))
    if report["counts"]["baselineRejected"]:
        return 2
    return int(bool(report["counts"]["regressed"]))


if __name__ == "__main__":
    sys.exit(main())
