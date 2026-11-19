"""Read-only WAV/hash audit for generated pilot directories; standard library only."""
import argparse
import array
import hashlib
import json
import math
import sys
import wave
from collections import Counter
from pathlib import Path


def inspect(root):
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("plan_only") or not manifest.get("complete"):
        raise ValueError(f"Incomplete or plan-only manifest: {root}")
    items = manifest["items"]
    records = []
    seen = set()
    for item in items:
        target = (root / item["file"]).resolve()
        if not target.is_relative_to(root.resolve()):
            raise ValueError("Manifest path escapes cohort directory")
        if target in seen:
            raise ValueError(f"Duplicate output reference: {target.name}")
        seen.add(target)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if digest != item["sha256"]:
            raise ValueError(f"Hash mismatch: {target}")
        if item.get("native_file"):
            native = (root / item["native_file"]).resolve()
            if not native.is_relative_to(root.resolve()):
                raise ValueError("Native path escapes cohort directory")
            if hashlib.sha256(native.read_bytes()).hexdigest() != item["native_sha256"]:
                raise ValueError(f"Native hash mismatch: {native}")
        with wave.open(str(target), "rb") as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1, 2, 16000, "NONE"):
                raise ValueError(f"Not PCM16 mono 16kHz: {target}")
            declared = wav.getnframes()
            raw = wav.readframes(declared)
        if not declared or len(raw) != declared * 2:
            raise ValueError(f"Empty or truncated WAV: {target}")
        values = array.array("h", raw)
        if sys.byteorder != "little":
            values.byteswap()
        rms = math.sqrt(sum(int(value) ** 2 for value in values) / len(values))
        peak = max(abs(value) for value in values)
        if not math.isfinite(rms) or not peak:
            raise ValueError(f"Nonfinite or silent WAV: {target}")
        duration = len(values) / 16000
        if abs(item["duration_s"] - duration) > 1 / 16000:
            raise ValueError(f"Duration mismatch: {target}")
        records.append(dict(file=item["file"], phrase=item["phrase"],
                            duration_s=duration, rms_pcm=rms, peak_pcm=peak,
                            clipping_fraction=sum(value in (-32768, 32767) for value in values) / len(values)))
    if not records:
        raise ValueError(f"No output records: {root}")
    return dict(directory=str(root), label=manifest["label"], files=len(records),
                phrase_counts=dict(Counter(record["phrase"] for record in records)),
                total_duration_s=sum(record["duration_s"] for record in records),
                duration_range_s=[min(record["duration_s"] for record in records), max(record["duration_s"] for record in records)],
                rms_range_pcm=[min(record["rms_pcm"] for record in records), max(record["rms_pcm"] for record in records)],
                max_peak_pcm=max(record["peak_pcm"] for record in records),
                max_clipping_fraction=max(record["clipping_fraction"] for record in records),
                clips_with_clipping=sum(record["clipping_fraction"] > 0 for record in records),
                hash_and_format_pass=True, pronunciation_review="not measured by this audit", items=records)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("roots", nargs="+", type=Path)
    args = parser.parse_args()
    roots = set()
    for root in args.roots:
        if (root / "manifest.json").exists():
            roots.add(root.resolve())
        else:
            roots.update(path.parent.resolve() for path in root.rglob("manifest.json"))
    if not roots:
        raise ValueError("No manifests found")
    print(json.dumps({"cohorts": [inspect(root) for root in sorted(roots)]}, indent=2))


if __name__ == "__main__":
    main()
