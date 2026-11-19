import { ROOT_CONTEXT } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { CorrelationSpanProcessor, ScrubbingSpanProcessor, createSpanScrubber } from '../src/telemetry-export.ts';
import { TRACE_ATTRS_KEY, canonicalConversationId, conversationAttributes } from '../src/telemetry-metadata.ts';

const HEX = '71fbd2912e96448d9647a07e16a6ce16';
const DASHED = '71fbd291-2e96-448d-9647-a07e16a6ce16';

// Same rule as apps/api/src/platform/ids.ts for conversations, as a pure string rule.
const VECTORS: Array<[string, string, string]> = [
  ['legacy cnv_ dashed', `cnv_${DASHED}`, `conv_${HEX}`],
  ['legacy cnv_ plain hex', `cnv_${HEX}`, `conv_${HEX}`],
  ['legacy thr_ dashed', `thr_${DASHED}`, `conv_${HEX}`],
  ['legacy thr_ plain hex', `thr_${HEX}`, `conv_${HEX}`],
  ['uppercase legacy', `cnv_${DASHED.toUpperCase()}`, `conv_${HEX}`],
  ['canonical', `conv_${HEX}`, `conv_${HEX}`],
  ['canonical with dashed uuid', `conv_${DASHED}`, `conv_${HEX}`],
  ['none', 'none', 'none'],
  ['short canonical-looking', 'conv_aaaa', 'conv_aaaa'],
  ['legacy non-uuid', 'cnv_notauuid', 'cnv_notauuid'],
  ['other prefix', `msg_${HEX}`, `msg_${HEX}`],
  ['plain uuid, no prefix', DASHED, DASHED],
  ['empty', '', ''],
];

describe('canonicalConversationId', () => {
  it.each(VECTORS)('%s', (_name, input, expected) => {
    expect(canonicalConversationId(input)).toBe(expected);
  });

  it('is applied to the conversation span attributes', () => {
    expect(conversationAttributes(`cnv_${DASHED}`, 'explicit')).toMatchObject({
      'bob.conversation.id': `conv_${HEX}`, 'gen_ai.conversation.id': `conv_${HEX}`,
    });
  });
});

function pipeline() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new ScrubbingSpanProcessor(createSpanScrubber(false), [new CorrelationSpanProcessor(), new SimpleSpanProcessor(exporter)])],
  });
  return { exporter, tracer: provider.getTracer('test') };
}

describe('CorrelationSpanProcessor at span end', () => {
  it('exports transcription / text_to_speech even when the SDK marks the span chat after start; a real chat span stays chat', () => {
    const { exporter, tracer } = pipeline();
    for (const [name, operationId] of [['ai.transcribe whisper-1', 'ai.transcribe'], ['ai.generateSpeech tts-1', 'ai.generateSpeech'], ['ai.generateText gpt', 'ai.generateText']]) {
      const span = tracer.startSpan(name!);
      span.setAttributes({ 'ai.operationId': operationId!, 'gen_ai.operation.name': 'chat' });
      span.end();
    }
    expect(exporter.getFinishedSpans().map((span) => span.attributes['gen_ai.operation.name'])).toEqual(['transcription', 'text_to_speech', 'chat']);
  });

  it('drops the empty cost on a speech span the SDK labelled late', () => {
    const { exporter, tracer } = pipeline();
    const span = tracer.startSpan('ai.transcribe whisper-1');
    span.setAttributes({ 'ai.operationId': 'ai.transcribe', 'gen_ai.usage.cost': 0 });
    span.end();
    expect(exporter.getFinishedSpans()[0]!.attributes).not.toHaveProperty('gen_ai.usage.cost');
  });

  it('stamps canonical conversation attributes for a legacy id in the trace context', () => {
    const { exporter, tracer } = pipeline();
    const ctx = ROOT_CONTEXT.setValue(TRACE_ATTRS_KEY, { conversationId: `cnv_${DASHED}`, conversationSource: 'explicit' });
    tracer.startSpan('work', {}, ctx).end();
    expect(exporter.getFinishedSpans()[0]!.attributes).toMatchObject({ 'bob.conversation.id': `conv_${HEX}`, 'gen_ai.conversation.id': `conv_${HEX}` });
  });

  it('an AI span keeps the client session only as bob.session.id; other spans keep both', () => {
    const { exporter, tracer } = pipeline();
    // OpenObserve replaces gen_ai.conversation.id with session.id on AI spans, which split a conversation's model calls by tab.
    const ctx = ROOT_CONTEXT.setValue(TRACE_ATTRS_KEY, { conversationId: `conv_${HEX}`, conversationSource: 'client', sessionId: 'tab-1' });
    tracer.startSpan('chat gemini', { attributes: { 'gen_ai.operation.name': 'chat' } }, ctx).end();
    tracer.startSpan('web-chat-turn', {}, ctx).end();
    const [ai, plain] = exporter.getFinishedSpans();
    expect(ai!.attributes).toMatchObject({ 'gen_ai.conversation.id': `conv_${HEX}`, 'bob.session.id': 'tab-1' });
    expect(ai!.attributes).not.toHaveProperty('session.id');
    expect(plain!.attributes).toMatchObject({ 'session.id': 'tab-1', 'bob.session.id': 'tab-1' });
  });

  it('a span with any gen_ai.* attribute (model, usage) counts as an AI span, even without an operation label', () => {
    const { exporter, tracer } = pipeline();
    // Our speech wrappers (speech-stt-provider, speech-tts-provider) set the model but no operation; OpenObserve
    // still rewrites their conversation id to session.id.
    const ctx = ROOT_CONTEXT.setValue(TRACE_ATTRS_KEY, { conversationId: `conv_${HEX}`, conversationSource: 'device', sessionId: 'session_1' });
    tracer.startSpan('speech-stt-provider', { attributes: { 'gen_ai.request.model': 'fish-audio/transcribe-1' } }, ctx).end();
    const [wrapper] = exporter.getFinishedSpans();
    expect(wrapper!.attributes).toMatchObject({ 'gen_ai.conversation.id': `conv_${HEX}`, 'bob.session.id': 'session_1' });
    expect(wrapper!.attributes).not.toHaveProperty('session.id');
  });
});
