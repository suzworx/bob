# Document processing: first evaluation slice

The Core module `apps/ai/src/document-processing.ts` classifies bounded text,
extracts invoice/receipt fields with supporting quotes, and checks grounding,
required fields, decimal amounts, dates, currency-code shape, and arithmetic.
Classification and financial extraction take separate injected AI SDK models.
No tools, persistence, external URL fetching, or document-bearing telemetry run.

This is an executable evaluation foundation, not yet connected to chat uploads.
PDF, images, Office files, OCR, tables, localized amounts and handwritten forms
still need adapters and their own fixtures. Chat accepts PDF, Word and plain-text attachments separately from this evaluation pipeline (see below). The first technique is structured text extraction.

Unknown or low-confidence classification abstains; supported financial types
receive extraction; other types return `needs_review`. The 0.85 confidence cutoff
is provisional, not calibrated. `checks_passed` means only the listed checks
passed, not authenticity, accounting approval, or factual certification. Quote
matching verifies presence, not semantic attribution. Currency validation checks
shape rather than the ISO registry. The arithmetic check assumes subtotal plus
tax equals total; discounts, shipping and multi-currency documents need review.

## Run

Unit regression checks:

```powershell
npx vitest run apps/ai/tests/document-processing.test.ts
```

Live synthetic smoke eval (dev Gateway key required; production-key guard applies):

```powershell
$env:DOCUMENT_EVAL_MODELS = '<gateway-model-id>,<another-gateway-model-id>'
npx tsx apps/ai/evals/documents.eval.ts
```

The runner verifies candidate IDs against the current Gateway catalog, uses at
most four candidates and twelve requests per candidate, disables retries, and
limits each document to sixty seconds. It reports classification accuracy per
case, total-field exact match, validation disposition and elapsed time without
printing document contents. Any failed assertion or provider error exits nonzero.
No model has been selected or promoted by this smoke suite. It does not measure
all extracted fields, token cost, repeated-run variance or full classification
coverage; do not treat its six examples as a production benchmark.

2026-10-23 run: `openai/gpt-6-luna` and `google/gemini-3.8-flash` were present
in the Gateway catalog, but every case failed before generation. A minimal
provider probe confirmed `GatewayAuthenticationError`. There are no live quality
scores from this run. Fourteen deterministic tests and the AI typecheck pass;
the full software gate is failing on concurrent changes outside this slice.

## Next delivery slices

1. Expand labeled synthetic and consented held-out fixtures: unknown, mixed,
   multilingual, rotated/scanned, tables, corrupt/encrypted files, ambiguous
   dates, currencies, credits/discounts and adversarial instructions.
2. Compare native PDF/vision, text extraction and OCR with page-level provenance.
   Score every field, abstention precision/recall, unsupported-value rate, p50/p95
   latency, tokens and priced cost. Calibrate thresholds on a separate split.
3. Select stage-specific routing only after the held-out quality floor passes;
   benchmark cheaper-first escalation against single-model baselines.
4. Integrate authorized chat/Gmail attachment ingestion with file signatures,
   decompression/page limits, account/space isolation, cancellation and review UI.
   Keep provider choice in Core and source access in the owning API feature.

## Chat document attachments

The chat picker and drop target accept PDF, Word (`.doc` and `.docx`), UTF-8
plain text (`.txt`), and the existing image formats. Existing limits apply:
four files, 4 MiB each, 8 MiB per message. Originals remain in the authorized
conversation; only the provider view is transformed.

PDF is passed to the chat model as native file input after a signature check;
this does not validate every PDF structure or prove support by every model.
Word is converted to text in isolated workers, with two parsers at once, a
five-second timeout and bounded heap. DOCX archives are limited to 256 entries
and 8 MiB declared uncompressed data. Plain text must be valid UTF-8. Extracted
text is limited to 60,000 characters per file and 120,000 per turn; older
history documents fall out of the provider view first. Word extraction does
not preserve embedded images, tables as structured data, or layout. Scanned
Word documents need a separate OCR path.

Invalid documents are rejected before conversation creation or message edits;
Stop cancels parsing, and parser congestion returns a retryable response.
Document text is marked as untrusted material and is never logged. This upload
support does not yet invoke the classification/extraction evaluation pipeline
or select a model based on document type.
