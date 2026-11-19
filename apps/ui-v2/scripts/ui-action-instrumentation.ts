import { parse } from '@babel/parser';
import * as t from '@babel/types';
import type { Plugin } from 'vite';
import actionCatalog from '../src/lib/observability/ui-action-catalog.json' with { type: 'json' };
import { collectUiListeners } from './ui-listener-coverage';

type ActionSite = { id: string; trigger: string; category: 'action' | 'edit' | 'activity'; start: number; end: number; mode: 'callback' | 'shorthand' | 'link' };
const CALLBACK = /^(on[A-Z]\w*|clickAction)$/;
export const UI_PASSIVE_CALLBACKS = {
  onRender: 'React commit durations have their own bounded render metrics.',
  onTimeUpdate: 'Media playback progress is measured by voice timings; it is not a user action.',
};
const EXCLUDED = new Set(Object.keys(UI_PASSIVE_CALLBACKS));

function slug(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function name(node: t.Node | null | undefined): string {
  if (t.isIdentifier(node) || t.isJSXIdentifier(node)) return node.name;
  if (t.isStringLiteral(node)) return node.value;
  if (t.isJSXMemberExpression(node)) return name(node.property);
  return '';
}

function ownerName(ancestors: t.Node[]): string {
  for (const current of [...ancestors].reverse()) {
    if (t.isFunctionDeclaration(current) && current.id) return slug(current.id.name);
    if (t.isVariableDeclarator(current) && (t.isArrowFunctionExpression(current.init) || t.isFunctionExpression(current.init))) return slug(name(current.id));
  }
  return 'module';
}

function fixedLabel(entries: t.Node[]): string | undefined {
  for (const entry of entries) {
    if (!t.isJSXAttribute(entry) && !t.isObjectProperty(entry)) continue;
    const key = name(t.isJSXAttribute(entry) ? entry.name : entry.key);
    if (!['label', 'aria-label', 'id'].includes(key)) continue;
    if (t.isStringLiteral(entry.value)) return slug(entry.value.value);
  }
  return undefined;
}

function children(node: t.Node): t.Node[] {
  const fields = node as unknown as Record<string, unknown>;
  return (t.VISITOR_KEYS[node.type] ?? []).flatMap((key) => {
    const value = fields[key];
    return (Array.isArray(value) ? value : [value]).filter((item): item is t.Node => typeof item === 'object' && item !== null && 'type' in item);
  });
}

function callbackHint(expression: t.Node): string {
  if (t.isArrowFunctionExpression(expression) || t.isFunctionExpression(expression)) return callbackHint(expression.body);
  if (t.isIdentifier(expression)) return slug(expression.name);
  if (t.isMemberExpression(expression) || t.isOptionalMemberExpression(expression)) return slug(name(expression.property)) || 'handle';
  if (t.isCallExpression(expression) || t.isOptionalCallExpression(expression)) return callbackHint(expression.callee);
  return children(expression).map(callbackHint).find((hint) => hint !== 'handle') ?? 'handle';
}

function editing(candidate: Candidate, parent: t.Node | undefined): boolean {
  if (candidate.trigger !== 'onChange') return false;
  if (t.isObjectExpression(parent) && parent.properties.some((entry) => t.isObjectProperty(entry) && name(entry.key) === 'type' && t.isStringLiteral(entry.value, { value: 'text' }))) return true;
  if (['TextInput', 'TextArea', 'Textarea', 'ChatComposerInput', 'textarea'].includes(candidate.control)) return true;
  if (candidate.control !== 'input' || !t.isJSXOpeningElement(parent)) return false;
  const type = parent.attributes.find((attribute) => t.isJSXAttribute(attribute) && name(attribute.name) === 'type');
  return !type || (t.isJSXAttribute(type) && t.isStringLiteral(type.value) && ['text', 'email', 'password', 'search', 'tel', 'url', 'number'].includes(type.value.value));
}

function category(candidate: Candidate, parent: t.Node | undefined): ActionSite['category'] {
  if (['onKeyDown', 'onKeyUp', 'onKeyPress', 'onDragOver', 'onMouseMove', 'onPointerMove'].includes(candidate.trigger)) return 'activity';
  return editing(candidate, parent) ? 'edit' : 'action';
}

function assertSupported(node: t.Node, file: string, localFunctions: Set<string>): void {
  if (t.isObjectMethod(node) && CALLBACK.test(name(node.key))) throw new Error(`Unsupported callback method in ${file}; use an explicit callback property.`);
  if (t.isObjectProperty(node) && node.computed && (CALLBACK.test(name(node.key)) || t.isFunction(node.value) || CALLBACK.test(name(node.value)))) {
    throw new Error(`Unsupported computed callback in ${file}; use a fixed callback key.`);
  }
  if (t.isJSXSpreadAttribute(node) && t.isCallExpression(node.argument) && !localFunctions.has(name(node.argument.callee))) {
    throw new Error(`Unresolved JSX callback spread in ${file}; bind explicit callback props.`);
  }
}

function siteRange(candidate: Candidate): Pick<ActionSite, 'start' | 'end'> {
  const expression = candidate.expression;
  const end = expression.end ?? 0;
  if (candidate.mode !== 'link') return { start: expression.start ?? 0, end };
  const start = end - (t.isJSXOpeningElement(expression) && expression.selfClosing ? 2 : 1);
  return { start, end: start };
}

type Candidate = { control: string; hint: string; trigger: string; expression: t.Node; mode: ActionSite['mode'] };

function callbackSite(node: t.Node, parent: t.Node | undefined): Candidate | null {
  if (t.isJSXAttribute(node) && t.isJSXOpeningElement(parent) && t.isJSXExpressionContainer(node.value)) {
    if (!CALLBACK.test(name(node.name))) return null;
    return { control: name(parent.name), hint: fixedLabel(parent.attributes) ?? callbackHint(node.value.expression), trigger: name(node.name), expression: node.value.expression, mode: 'callback' };
  }
  if (t.isObjectProperty(node) && t.isObjectExpression(parent) && !node.computed) {
    if (!CALLBACK.test(name(node.key))) return null;
    return { control: 'menu', hint: fixedLabel(parent.properties) ?? callbackHint(node.value), trigger: name(node.key), expression: node.shorthand ? node : node.value, mode: node.shorthand ? 'shorthand' : 'callback' };
  }
  return null;
}

function linkSite(node: t.Node): Candidate | null {
  if (!t.isJSXOpeningElement(node)) return null;
  const names = node.attributes.filter(t.isJSXAttribute).map((attribute) => name(attribute.name));
  if (!names.includes('href') || names.includes('onClick') || names.includes('clickAction')) return null;
  return { control: name(node.name), hint: 'navigate', trigger: 'onClick', expression: node, mode: 'link' };
}

/** Source code is the only naming input. No browser text, labels, values or URLs are read. */
export function collectUiActions(source: string, file: string): ActionSite[] {
  collectUiListeners(source, file);
  const parsed = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  const sites: ActionSite[] = [];
  const localFunctions = new Set<string>();
  function functions(node: t.Node): void {
    if (t.isFunctionDeclaration(node) && node.id) localFunctions.add(node.id.name);
    if (t.isVariableDeclarator(node) && (t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init))) localFunctions.add(name(node.id));
    for (const child of children(node)) functions(child);
  }
  functions(parsed);
  const counts = new Map<string, number>();
  const prefix = file.replace(/^features\//, '').replace(/\.tsx?$/, '').split('/').map(slug).join('.');
  function visit(node: t.Node, ancestors: t.Node[]): void {
    assertSupported(node, file, localFunctions);
    const candidate = callbackSite(node, ancestors.at(-1)) ?? linkSite(node);
    if (candidate && CALLBACK.test(candidate.trigger) && !EXCLUDED.has(candidate.trigger)) {
      const base = [prefix, ownerName(ancestors), slug(candidate.control), candidate.hint, slug(candidate.trigger.replace(/^on/, ''))].join('.');
      const occurrence = (counts.get(base) ?? 0) + 1;
      counts.set(base, occurrence);
      const id = occurrence === 1 ? base : `${base}.${occurrence}`;
      sites.push({ id, trigger: candidate.trigger, ...siteRange(candidate), mode: candidate.mode, category: category(candidate, ancestors.at(-1)) });
    }
    for (const child of children(node)) visit(child, [...ancestors, node]);
  }
  visit(parsed, []);
  return sites.sort((a, b) => a.start - b.start);
}

export function instrumentUiActions(source: string, file: string, sites = collectUiActions(source, file)): string {
  if (sites.length === 0) return source;
  const edits: Array<{ at: number; value: string }> = [];
  for (const site of sites) {
    if (site.mode === 'link') {
      edits.push({ at: site.start, value: ` onClick={__bobUiAction(${JSON.stringify(site.id)}, () => undefined)}` });
    } else if (site.mode === 'shorthand') {
      edits.push({ at: site.start, value: `${site.trigger}: __bobUiAction(${JSON.stringify(site.id)}, ` }, { at: site.end, value: ')' });
    } else {
      edits.push({ at: site.start, value: `__bobUiAction(${JSON.stringify(site.id)}, ` }, { at: site.end, value: ')' });
    }
  }
  let output = source;
  for (const edit of edits.sort((a, b) => b.at - a.at)) output = output.slice(0, edit.at) + edit.value + output.slice(edit.at);
  return `import { observeUiAction as __bobUiAction } from '@/lib/observability/ui-actions';\n${output}`;
}

export function uiActionInstrumentation(): Plugin {
  const allowed = new Set<string>(actionCatalog.map(({ id }) => id));
  return {
    name: 'bob-safe-ui-actions',
    enforce: 'pre',
    transform(source, id) {
      const file = id.replaceAll('\\', '/').split('/ui-v2/src/')[1];
      if (!file || !/\.tsx?$/.test(file) || /(?:\.test\.|test-setup|lib\/observability\/)/.test(file)) return;
      const actions = collectUiActions(source, file);
      for (const action of actions) {
        if (!allowed.has(action.id)) throw new Error(`UI action catalog missing ${action.id}; run npx tsx apps/ui-v2/scripts/generate-ui-action-catalog.ts`);
      }
      return { code: instrumentUiActions(source, file, actions), map: null };
    },
  };
}
