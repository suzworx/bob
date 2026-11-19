"""Pinned synthetic pilot. Plan mode requires only Python stdlib."""
import argparse
import hashlib
import json
import math
import time
from pathlib import Path

MODEL = "ai4bharat/indic-parler-tts"
REVISION = "660bc53c64ae83150613264111708a0465211237"
VOICES = {"Hindi": ["Rohit", "Divya"], "Telugu": ["Prakash", "Lalitha"],
          "Tamil": ["Kavitha", "Jaya"], "Malayalam": ["Anjali", "Harish"],
          "Kannada": ["Suresh", "Anu"], "English": ["Thoma", "Mary"]}
TEXTS = ["Hey Bob", "Hey Bob", "Alexa", "Hey Rob, please bring the box."]


def load_resume(root, expected_items):
    """Validate checkpoints before importing GPU libraries or modifying files."""
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("complete") or manifest.get("plan_only"):
        raise ValueError("Resume requires an interrupted inference batch")
    if manifest.get("model") != MODEL or manifest.get("revision") != REVISION:
        raise ValueError("Resume model/revision differs from this generator")
    items = manifest["items"]
    if len(items) != len(expected_items):
        raise ValueError("Resume limit differs from the original plan")
    for item, expected in zip(items, expected_items):
        if any(item.get(key) != value for key, value in expected.items()):
            raise ValueError("Resume phrase/voice/style/seed configuration differs")
        if item.get("sha256"):
            target = (root / item["file"]).resolve()
            if not target.is_relative_to(root.resolve()):
                raise ValueError("Checkpoint file escapes output directory")
            if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != item["sha256"]:
                raise ValueError("Checkpoint file missing or checksum mismatch")
    if any(item.get("sha256") or item.get("generation_failure") for item in items):
        if not manifest.get("description_tokenizer") or not manifest.get("description_revision"):
            raise ValueError("Checkpoint lacks description tokenizer provenance")
    return manifest


def description_revision_for(manifest, description_model, resolve_revision):
    if manifest.get("description_tokenizer") not in (None, description_model):
        raise ValueError("Description tokenizer differs from checkpoint")
    return manifest.get("description_revision") or resolve_revision(description_model)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument("--limit", type=int, default=96)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.limit <= 96:
        parser.error("--limit must be between 1 and 96")
    if args.resume and args.plan_only:
        parser.error("--resume cannot be combined with --plan-only")
    args.out.mkdir(parents=True, exist_ok=args.resume)
    items = []
    for language, voices in VOICES.items():
        for speaker in voices:
            for style in ["normal", "slow"]:
                seed = 41000 + len(items)
                for phrase in TEXTS:
                    items.append(dict(language_voice_group=language, speaker=speaker,
                        style=style, phrase=phrase, seed=seed,
                        kind="negative" if phrase.startswith("Hey Rob") else "positive",
                        description=f"{speaker} speaks at a {style} pace with a neutral tone. The recording has very clear audio, no background noise, and a close-sounding voice."))
    items = items[:args.limit]
    manifest = dict(model=MODEL, revision=REVISION, plan_only=args.plan_only,
        complete=False, label="Synthetic regional-language voice proxies; English phrases; accents and pronunciation unverified", items=items)
    target = args.out / "manifest.json"
    if args.resume:
        manifest = load_resume(args.out, items)
        items = manifest["items"]
    target.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    if args.plan_only:
        print(f"Plan: {len(items)} clips, no model loaded")
        return
    import numpy as np
    import soundfile as sf
    import torch
    from huggingface_hub import HfApi
    from parler_tts import ParlerTTSForConditionalGeneration
    from scipy.signal import resample_poly
    from transformers import AutoTokenizer
    model = ParlerTTSForConditionalGeneration.from_pretrained(MODEL, revision=REVISION).to("cuda:0")
    tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=REVISION)
    description_model = model.config.text_encoder._name_or_path
    description_revision = description_revision_for(manifest, description_model,
        lambda name: HfApi().model_info(name).sha)
    description_tokenizer = AutoTokenizer.from_pretrained(description_model, revision=description_revision)
    manifest.update(description_tokenizer=description_model, description_revision=description_revision,
                    torch_version=torch.__version__, gpu=torch.cuda.get_device_name(0), native_rate=model.config.sampling_rate)
    target.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    model.eval()
    for index, item in enumerate(items):
        if item.get("sha256") or item.get("generation_failure"):
            continue
        torch.manual_seed(item["seed"])
        description = description_tokenizer(item["description"], return_tensors="pt").to("cuda:0")
        prompt = tokenizer(item["phrase"], return_tensors="pt").to("cuda:0")
        started = time.monotonic()
        with torch.inference_mode():
            generated = model.generate(input_ids=description.input_ids, attention_mask=description.attention_mask,
                prompt_input_ids=prompt.input_ids, prompt_attention_mask=prompt.attention_mask,
                max_new_tokens=1500)
        audio = generated.float().cpu().numpy().squeeze()
        if audio.ndim != 1 or not len(audio) or not np.isfinite(audio).all():
            item["generation_failure"] = dict(shape=list(audio.shape), finite=bool(np.isfinite(audio).all()))
            target.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            print(f"FAILED {index+1}/{len(items)} invalid audio {item['generation_failure']}", flush=True)
            continue
        sr = int(model.config.sampling_rate)
        divisor = math.gcd(sr, 16000)
        normalized = resample_poly(audio, 16000 // divisor, sr // divisor)
        filename = f"{index:03d}-{item['language_voice_group']}-{item['speaker']}-{item['style']}.wav"
        sf.write(args.out / filename, normalized, 16000, subtype="PCM_16")
        item.update(file=filename, sha256=hashlib.sha256((args.out / filename).read_bytes()).hexdigest(),
                    duration_s=len(normalized)/16000, generation_seconds=time.monotonic()-started,
                    peak_before_pcm=float(np.max(np.abs(normalized))), max_new_tokens=1500,
                    duration_outlier=not (0.2 <= len(normalized)/16000 <= 8))
        target.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(f"Completed {index+1}/{len(items)} {filename}", flush=True)
    failures = [item for item in items if item.get("generation_failure")]
    manifest["failed_items"] = failures
    manifest["items"] = [item for item in items if item.get("sha256")]
    manifest["requested_count"] = len(items)
    manifest["complete"] = True
    target.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
