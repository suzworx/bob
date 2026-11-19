---
name: runpod-tts-batch
description: Generate and scale reproducible synthetic speech batches on Runpod GPUs, with model-access checks, manifests, audio validation, downloads and confirmed pod cleanup.
---

# Runpod TTS batches

Deliver local WAVs, provenance manifests, an audit and confirmed termination of this run's resources. Planning or creating a skill does not authorize paid execution. Reuse authorization already given; resolve genuinely missing spend or scope constraints before renting resources.

## Steps

1. Define exact phrases, negatives, language-associated voice groups, speakers, styles and seeds. Keep comparison cells balanced and trained wake phrases intact. Label synthetic voice groups as accent proxies until reviewed by listeners.
2. Verify Runpod authentication without printing credentials. For Hugging Face use `hf auth login`, then attempt an authenticated download of the pinned model. Login alone does not grant gated-model access. Have the user complete any required contact-sharing agreement before renting a GPU.
3. Pin model/library commits and record weight checksum, tokenizer revision, dtype, generation settings and package versions. Read [the tested Indic Parler recipe](references/indic-parler.md) for its scripts and limitations.
4. Check current GPU availability and rate. Choose sufficient VRAM, ephemeral storage and a bounded deadline. Assign one owner to each pod; record its ID and arm independent cleanup. A local watchdog requires the host to stay awake. Retain an explicit manual deletion fallback.
5. Transfer scripts and credentials securely; token files mode 600, no secrets in logs or archives. Install compatible CUDA/PyTorch dependencies and pinned model code.
6. Run actual smoke inference before expanding. Audit the samples and measure throughput/memory to estimate full-run cost. Review pronunciation when playback is available; imports alone do not prove inference.
7. Generate with per-item checkpoints: stable ID, phrase, speaker/group/style, seed, inference time, duration and file hash. Record empty, scalar, nonfinite and truncated outputs as failures. Retain original failures when recording a retry with a new seed or configuration.
8. Download and verify archive and per-file hashes. Normalize to the requested format (wake-word default PCM16 mono 16 kHz). Use `scripts/verify_outputs.py` to audit nonempty WAVs, duration, RMS and clipping. Audio-format success does not prove intelligibility, authentic accents or wake-word detection.
9. In success and failure paths, salvage outputs within the deadline and delete this run's pod. Confirm deletion and check associated billable storage. Only then stop its watchdog and remove temporary credential copies. Do not touch unrelated resources.
10. Deliver a ZIP and report: attempted/valid/failed counts per phrase/group, missing comparison cells, clipping, timings, provenance, cleanup evidence and untested items. Distinguish rate-times-elapsed estimates from invoices.

## Scale-out procedure

- Review small samples from every group before mass generation. Measure one GPU before deciding whether larger inference batches or multiple pods help.
- Freeze a master manifest with globally unique item IDs. Assign disjoint shards, separate output folders and a single pod lifecycle owner per shard.
- Keep matched phrase/voice/style cells across wake-word comparisons. Report gaps or evaluate the matched intersection rather than silently comparing unequal totals.
- Split training and held-out speaker identities before generation. Speed variants and repeated seeds are not independent speakers.
- Bound aggregate pod count, total cost and deadline within user authorization. Each pod needs cleanup and downloadable checkpoints.
- Verify saved hashes and unchanged configuration before resuming unfinished items. Never overwrite completed failure accounting.
- Merge compatible manifests only; reject duplicate IDs, missing files and checksum mismatches. Audit merged outputs and retain each shard's failures.

The bundled generator implements the tested single-pod 96-item pilot, not parallel orchestration. For larger runs, add explicit master-manifest/shard inputs and test disjoint assignment before paid dispatch. Running identical copies creates duplicates, not scale-out.
