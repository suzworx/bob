# Tested Indic Parler recipe

Official source: https://huggingface.co/ai4bharat/indic-parler-tts

Reproduction pins from 2026-10-10:
- Model: 660bc53c64ae83150613264111708a0465211237
- Weight SHA256: c68daecb60f80c8f1faf0a6d2e6ddd6de8e224fb19750f3e9a33bca43c552c90
- Parler library: d108732cd57788ec86bc857d99a6cabd66663d68
- float32 PyTorch 2.8 CUDA, A40. These are historical pins, not latest-version claims.

Scripts in ../scripts:
- generate.py: flags --out, --limit, --plan-only, --resume. Plan mode uses Python stdlib.
- setup.sh: Linux venv /root/indic-venv using system packages, pinned Parler code plus scipy/soundfile. Capture pip freeze; this is not a complete dependency lock.
- verify_outputs.py: stdlib audit. Manifest requires complete:true, plan_only:false, label, items with file/sha256/duration_s/phrase; failed_items stores failures separately.

On the pod after access verification and bounded provisioning:

```sh
bash setup.sh
/root/indic-venv/bin/python generate.py --out smoke --limit 4
/root/indic-venv/bin/python verify_outputs.py smoke > smoke-audit.json
/root/indic-venv/bin/python generate.py --out batch
/root/indic-venv/bin/python verify_outputs.py batch > batch-audit.json
/root/indic-venv/bin/pip freeze > batch/pip-freeze.txt
```

Local planning: `python generate.py --out plan-preview --plan-only`. New output directories must not exist. Resume is only for interrupted inference batches and must use the original `--limit`. Completed and plan-only batches are rejected. Before loading GPU libraries, resume verifies model/plan identity and every successful file hash. It retains failed items and reuses the recorded description-tokenizer revision. The revision is resolved on the first run and checkpointed before generation.

Offline regression checks: `python -m unittest discover -s scripts -p test_generate.py` from this skill directory. These exercise checkpoint rejection, unchanged failure accounting, output hashes, plan identity and tokenizer pinning without GPU dependencies.

Pilot: Hindi Rohit/Divya; Telugu Prakash/Lalitha; Tamil Kavitha/Jaya; Malayalam Anjali/Harish; Kannada Suresh/Anu; English Thoma/Mary. Normal/slow pace. Texts: Hey Bob, Hey Bob, Alexa, Hey Rob please bring the box (see script for punctuation).

Observed 90/96 valid, 154.2647 seconds. Six single-sample failures: Bob and Alexa for Divya slow, Kavitha normal, Anjali slow. Three valid clips had minor clipping, maximum 0.0163% samples. No listening/device qualification. These failures are TTS failures, not device misses.

Historical rate $0.59/hour for approximately nine minutes, deletion verified. Recheck live rates/availability. Never bundle tokens, provider configuration, private keys or historical pod IDs as executable defaults.
