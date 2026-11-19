import { recordObservationMetrics, traceSpan } from '@bob/ai';

type RetrievalStage = 'retrieval' | 'availability' | 'embedding' | 'hybrid-search' | 'fulltext-search' | 'due-soon' | 'standing' | 'top';

/** Stage clocks overlap deliberately: concurrent lookups are not summed. */
export function retrievalStage<T>(stage: RetrievalStage, clock: () => number, run: () => Promise<T>, count?: (value: T) => number): Promise<T> {
  const observationType = stage === 'embedding' || stage === 'availability' ? 'span' : 'retriever';
  return traceSpan(`memory-${stage}`, { observationType, metadata: { action: stage } }, async () => {
    const started = clock();
    let failed = false;
    try {
      const result = await run();
      if (count) {
        const size = count(result);
        recordObservationMetrics([
          { name: 'rag.result_count', value: Math.min(1_000_000, Math.max(0, size)) },
          { name: 'rag.empty', value: Number(size === 0) },
        ]);
      }
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      recordObservationMetrics([
        { name: 'rag.duration_ms', value: Math.min(600000, Math.max(0, Math.round(clock() - started))) },
        { name: 'rag.failed', value: Number(failed) },
      ]);
    }
  });
}
