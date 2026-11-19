"""Offline checkpoint regression tests; no model downloads or GPU dependencies."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import generate


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.expected = [dict(phrase="Hey Bob", seed=41000, speaker="Rohit")]
        self.item = dict(self.expected[0], file="clip.wav", sha256=hashlib.sha256(b"audio").hexdigest())
        (self.root / "clip.wav").write_bytes(b"audio")
        self.manifest = dict(model=generate.MODEL, revision=generate.REVISION,
            complete=False, plan_only=False, items=[self.item],
            description_tokenizer="encoder", description_revision="pinned")

    def save(self):
        target = self.root / "manifest.json"
        target.write_text(json.dumps(self.manifest), encoding="utf-8")
        return target.read_bytes()

    def test_valid_checkpoint_and_failure_preserved(self):
        self.save()
        self.assertEqual(generate.load_resume(self.root, self.expected)["items"][0], self.item)
        failure = dict(self.expected[0], generation_failure={"shape": []})
        self.manifest["items"] = [failure]
        self.save()
        result = generate.load_resume(self.root, self.expected)
        self.assertEqual(result["items"][0]["generation_failure"], {"shape": []})

    def test_completed_and_plan_only_rejected_without_mutation(self):
        for flag in ("complete", "plan_only"):
            with self.subTest(flag=flag):
                self.manifest[flag] = True
                original = self.save()
                with self.assertRaises(ValueError):
                    generate.load_resume(self.root, self.expected)
                self.assertEqual((self.root / "manifest.json").read_bytes(), original)
                self.manifest[flag] = False

    def test_missing_and_modified_outputs_rejected(self):
        self.save()
        (self.root / "clip.wav").write_bytes(b"modified")
        with self.assertRaises(ValueError):
            generate.load_resume(self.root, self.expected)
        (self.root / "clip.wav").unlink()
        with self.assertRaises(ValueError):
            generate.load_resume(self.root, self.expected)

    def test_changed_model_plan_and_missing_provenance_rejected(self):
        baseline = copy.deepcopy(self.manifest)
        for field in ("model", "revision", "description_revision"):
            with self.subTest(field=field):
                self.manifest = copy.deepcopy(baseline)
                self.manifest[field] = None
                self.save()
                with self.assertRaises(ValueError):
                    generate.load_resume(self.root, self.expected)
        self.manifest = baseline
        self.save()
        with self.assertRaises(ValueError):
            generate.load_resume(self.root, [dict(self.expected[0], seed=999)])
        with self.assertRaises(ValueError):
            generate.load_resume(self.root, [])

    def test_checkpoint_path_escape_rejected(self):
        self.item["file"] = "../elsewhere.wav"
        self.save()
        with self.assertRaises(ValueError):
            generate.load_resume(self.root, self.expected)

    def test_pinned_tokenizer_does_not_query_latest(self):
        def forbidden_lookup(_):
            self.fail("Resume queried latest tokenizer")
        self.assertEqual(generate.description_revision_for(self.manifest, "encoder", forbidden_lookup), "pinned")
        with self.assertRaises(ValueError):
            generate.description_revision_for(self.manifest, "other", forbidden_lookup)


if __name__ == "__main__":
    unittest.main()
