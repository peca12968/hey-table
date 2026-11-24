from copy import deepcopy
import unittest

from replay import compare


def doc(schema, path="/orders/{id}", required=True):
    body = {"required":required,"content":{"application/json":{"schema":schema}}}
    return {"openapi":"3.1.0","paths":{path:{"post":{"requestBody":body}}}}


def case(body, **extra):
    return dict({"id":"sample","method":"POST","path":"/orders/12","body":body}, **extra)


class RequestReplayTests(unittest.TestCase):
    def test_escaped_nested_references_and_json_pointer(self):
        old = doc(True)
        new = doc({"$ref":"#/components/schemas/pieces~1v2"})
        new["components"] = {"schemas":{"pieces/v2":{"type":"object","properties":{"a/b~c":{
            "type":"array","items":{"$ref":"#/components/schemas/limit/anyOf/0"}}}},
            "limit":{"anyOf":[{"type":"integer","maximum":2}]}}}
        direct = new["paths"]["/orders/{id}"]["post"]
        new["components"]["requestBodies"] = {"order":direct["requestBody"]}
        direct["requestBody"] = {"$ref":"#/components/requestBodies/order"}
        report = compare(old,new,[case({"a/b~c":[2,3]},count=9)])
        self.assertEqual(report["counts"]["regressed"],9)
        failure = report["findings"][0]
        self.assertEqual(failure["request"]["body"],{"a/b~c":[2,3]})
        self.assertEqual(failure["issues"][0]["pointer"],"/a~1b~0c/1")

    def test_missing_null_optional_and_weighted_baseline_errors(self):
        old = doc({"type":["null","string"]},required=False)
        new = doc({"type":"null"})
        absent = {"id":"missing","method":"post","path":"/orders/1","count":3}
        report = compare(old,new,[absent,case(None),case(123,id="bad",count=4)])
        self.assertEqual(report["counts"],dict(preserved=1,regressed=3,baselineRejected=4))
        self.assertEqual(report["findings"][0]["issues"],[{"rule":"body_required"}])
        self.assertNotIn("body",report["findings"][0]["request"])

    def test_literal_path_precedence_and_uncovered_or_removed_operations(self):
        old = doc(True)
        new = doc(True,"/orders/{number}")
        new["paths"]["/orders/pending"] = doc(False)["paths"]["/orders/{id}"]
        report = compare(old,new,[case(7,path="/orders/pending")])
        self.assertEqual(report["findings"][0]["issues"][0]["rule"],"falseSchema")
        self.assertEqual(report["uncoveredCandidateBodyOperations"],["POST /orders/{number}"])
        new["paths"]["/orders/{number}"] = {}
        self.assertEqual(compare(old,new,[case(1)])["findings"][0]["issues"],[{"rule":"operation_missing"}])

    def test_media_fallback_and_explicit_priority(self):
        old = doc(True)
        new = doc(False)
        media = new["paths"]["/orders/{id}"]["post"]["requestBody"]["content"]
        media["application/*"] = {}
        self.assertEqual(compare(old,new,[case("a")])["counts"]["regressed"],1)
        del media["application/json"]
        self.assertEqual(compare(old,new,[case("a")])["counts"]["preserved"],1)
        media.clear()
        media["text/plain"] = {}
        self.assertEqual(compare(old,new,[case("a")])["findings"][0]["issues"],[{"rule":"json_undocumented"}])

    def test_unknowns_do_not_become_passing_results(self):
        old = doc(True)
        ambiguous = deepcopy(old)
        ambiguous["paths"]["/orders/{other}"] = {}
        for invalid in [doc({"$ref":"https://example.invalid/schema"}), doc({"$ref":"#/missing"}),
                        doc({"$id":"urn:other"}), ambiguous, {**old,"openapi":"3.0.3"}]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                compare(old,invalid,[case(1)])
        for cases in [[],[case(1),case(2)],[case(1,count=True)],[case(1,path="/orders/{id}")]]:
            with self.assertRaises(ValueError):
                compare(old,old,cases)
