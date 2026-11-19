import { createContext, useContext, useEffect, useId, useState, type ComponentProps, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { Code } from '@astryxdesign/core/Code';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Link } from '@astryxdesign/core/Link';
import { Markdown, type MarkdownInlinePlugin } from '@astryxdesign/core/Markdown';
import { ScrollableArea } from '@astryxdesign/core/ScrollableArea';
import { navigateTo } from '../../app/routes';
import { useThemeChoice, type ThemeChoice } from '../../app/theme-choice';

type MarkdownComponents = NonNullable<ComponentProps<typeof Markdown>['components']>;
type CodeProps = ComponentProps<NonNullable<MarkdownComponents['code']>>;
type MathProps = ComponentProps<NonNullable<MarkdownComponents['math']>>;
type KatexApi = Pick<typeof import('katex'), 'renderToString'>;
type MermaidApi = typeof import('mermaid').default;

// KaTeX and mermaid are heavy, so each loads on its first use and stays out of
// the entry chunk. A failed load is forgotten so the next render can retry.
let katexLoad: Promise<KatexApi> | null = null;
function loadKatex(): Promise<KatexApi> {
  katexLoad ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([mod]) => (mod as { default?: KatexApi }).default ?? mod)
    .catch((error: unknown) => {
      katexLoad = null;
      throw error;
    });
  return katexLoad;
}

// `$…$` and `$$…$$` typeset through KaTeX. Until it has loaded, and whenever
// the expression does not parse, the raw expression shows as inline code.
function MathExpression({ value, display }: MathProps): ReactElement {
  const key = `${display}:${value}`;
  const [done, setDone] = useState<{ key: string; html: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const finish = (html: string | null): void => {
      if (!cancelled) setDone({ key, html });
    };
    void loadKatex().then(
      (katex) => {
        try {
          finish(katex.renderToString(value, { displayMode: display === 'block', throwOnError: true }));
        } catch {
          finish(null);
        }
      },
      () => finish(null),
    );
    return () => {
      cancelled = true;
    };
  }, [key, value, display]);

  if (done?.key !== key || done.html === null) return <Code>{value}</Code>;
  // KaTeX's own output (trust is off by default), never the raw expression.
  return display === 'block' ? (
    <ScrollableArea axis="inline" label="Math formula">
      <div dangerouslySetInnerHTML={{ __html: done.html }} />
    </ScrollableArea>
  ) : (
    <span dangerouslySetInnerHTML={{ __html: done.html }} />
  );
}

function PlainCode({ code, language }: CodeProps): ReactElement {
  return <CodeBlock code={code.replace(/\n$/, '')} language={language || 'plaintext'} width="100%" />;
}

let mermaidLoad: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  mermaidLoad ??= import('mermaid')
    .then((mod) => mod.default)
    .catch((error: unknown) => {
      mermaidLoad = null;
      throw error;
    });
  return mermaidLoad;
}

function isDark(choice: ThemeChoice): boolean {
  if (choice !== 'system') return choice === 'dark';
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// A ```mermaid fence, drawn to an SVG string once mermaid has loaded. Until
// then, and if the diagram does not render, the fence stays a plain code block.
function MermaidDiagram(props: CodeProps): ReactElement {
  const { code } = props;
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const dark = isDark(useThemeChoice());
  const key = `${dark}:${code}`;
  const [done, setDone] = useState<{ key: string; svg: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const finish = (svg: string | null): void => {
      if (!cancelled) setDone({ key, svg });
    };
    void loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          theme: dark ? 'dark' : 'default',
        });
        finish((await mermaid.render(id, code)).svg);
      })
      .catch(() => finish(null));
    return () => {
      cancelled = true;
    };
  }, [key, code, dark, id]);

  if (done?.key !== key || done.svg === null) return <PlainCode {...props} />;
  return (
    <ScrollableArea axis="inline" label="Diagram">
      <div
        role="img"
        aria-label="Diagram"
        dangerouslySetInnerHTML={{ __html: done.svg }}
      />
    </ScrollableArea>
  );
}

function SettledCode(props: CodeProps): ReactElement {
  return props.language === 'mermaid' ? <MermaidDiagram {...props} /> : <PlainCode {...props} />;
}

const APP_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SCHEMELESS_HOST = '[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\\d+)?';
// The app tools return a bare path, and a model that adds a host can only make one
// up (#1423), so http(s), // and schemeless hosts all mean this app. Anything more on
// the path, or a path inside another URL, is someone else's link.
const APP_HREF = new RegExp(`^(?:(?:https?:)?//[^/?#\\s]+|${SCHEMELESS_HOST})?(/apps/${APP_ID})/?$`, 'i');
const APP_TEXT = new RegExp(
  `(?<![\\w./:@?#=&%-])(?:(?:https?:)?//[^/?#\\s]+|${SCHEMELESS_HOST})?(/apps/${APP_ID})/?(?![\\w/?#=&%-]|\\.\\w)`,
  'gi',
);
const APP_LABEL = 'Open app';

// Which kind of link a text node sits in. Astryx hands over the parsed tree here, so
// code, images and math never reach these, and no source text is rewritten.
const EnclosingLink = createContext<'app' | 'other' | null>(null);

function AppLink({ path, children }: { path: string; children: ReactNode }): ReactElement {
  const open = (event: MouseEvent): void => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateTo(path);
  };
  return <Link href={path} type="inherit" hasUnderline onClick={open}><EnclosingLink.Provider value="app">{children}</EnclosingLink.Provider></Link>;
}

function MarkdownLink({ href, children }: { href: string; children: ReactNode }): ReactElement {
  const path = APP_HREF.exec(href)?.[1];
  if (path !== undefined) return <AppLink path={path}>{children}</AppLink>;
  const opensElsewhere = /^https?:\/\//i.test(href);
  return (
    <Link href={href} type="inherit" hasUnderline {...(opensElsewhere ? { target: '_blank' } : {})}>
      <EnclosingLink.Provider value="other">{children}</EnclosingLink.Provider>
    </Link>
  );
}

function AppTextMatch({ text, path }: { text: string; path: string }): ReactElement {
  const enclosing = useContext(EnclosingLink);
  if (enclosing === 'other') return <>{text}</>;
  if (enclosing === 'app') return <>{APP_LABEL}</>;
  return <AppLink path={path}>{APP_LABEL}</AppLink>;
}

const appLinkPlugins: MarkdownInlinePlugin[] = [
  { pattern: APP_TEXT, render: (match, key) => <AppTextMatch key={key} text={match[0]} path={match[1] ?? ''} /> },
];

// Module-level so their identity is stable: a new `code` component would
// remount every block. A half-written diagram would not parse, so fences stay
// code blocks until the reply has settled.
const streamingComponents: MarkdownComponents = { code: PlainCode, math: MathExpression, link: MarkdownLink };
const settledComponents: MarkdownComponents = { code: SettledCode, math: MathExpression, link: MarkdownLink };

export function RichMarkdown({
  children,
  isStreaming = false,
  density,
}: {
  children: string;
  isStreaming?: boolean;
  density?: 'default' | 'compact';
}): ReactElement {
  return (
    <Markdown
      density={density}
      headingLevelStart={3}
      contentWidth="100%"
      autolink="gfm"
      isStreaming={isStreaming}
      components={isStreaming ? streamingComponents : settledComponents}
      inlinePlugins={appLinkPlugins}
    >
      {children}
    </Markdown>
  );
}
