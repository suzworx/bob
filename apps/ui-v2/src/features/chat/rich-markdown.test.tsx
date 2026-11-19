import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { RichMarkdown } from './rich-markdown';

const mermaidMock = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
const katexMock = vi.hoisted(() => ({ renderToString: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaidMock }));
vi.mock('katex', () => ({ default: katexMock }));

function Harness({ children, isStreaming }: { children: string; isStreaming?: boolean }): ReactElement {
  return (
    <Theme theme={neutralTheme} mode="system">
      <RichMarkdown isStreaming={isStreaming}>{children}</RichMarkdown>
    </Theme>
  );
}

const diagram = '```mermaid\ngraph TD\n  A-->B\n```';

beforeEach(() => {
  mermaidMock.initialize.mockReset();
  mermaidMock.render.mockReset();
  katexMock.renderToString.mockReset();
  katexMock.renderToString.mockImplementation(
    (tex: string) => `<span data-testid="katex">${tex}</span>`,
  );
});
afterEach(cleanup);

describe('response formatting', () => {
  it('autolinks bare URLs in assistant replies', () => {
    render(<Harness>{'Read https://example.com/docs for details.'}</Harness>);
    expect(screen.getByRole('link', { name: 'https://example.com/docs' }).getAttribute('href')).toBe(
      'https://example.com/docs',
    );
  });

  it('starts markdown headings below the page heading level', () => {
    render(<Harness>{'# Plan\n\n- First\n- Second'}</Harness>);
    expect(screen.getByRole('heading', { level: 3, name: 'Plan' })).toBeTruthy();
  });
});

describe('code fences', () => {
  it('renders a normal fence as a code block with its text and a copy button', () => {
    render(<Harness>{'```bash\nnpm install\n```'}</Harness>);
    expect(screen.getByText('npm install')).toBeTruthy();
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy();
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(screen.queryByRole('img', { name: 'Diagram' })).toBeNull();
  });

  it('renders a mermaid fence through mermaid.render as a Diagram image', async () => {
    mermaidMock.render.mockResolvedValue({ svg: '<svg data-testid="diagram-svg"></svg>' });
    render(<Harness>{diagram}</Harness>);
    const image = await screen.findByRole('img', { name: 'Diagram' });
    expect(image.querySelector('[data-testid="diagram-svg"]')).not.toBeNull();
    expect(mermaidMock.render).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('graph TD'));
  });

  it('keeps a mermaid fence as a code block while the reply streams', async () => {
    render(<Harness isStreaming>{diagram}</Harness>);
    expect(await screen.findByText(/graph TD/)).toBeTruthy();
    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(screen.queryByRole('img', { name: 'Diagram' })).toBeNull();
  });

  it('falls back to the code block when the diagram does not render', async () => {
    mermaidMock.render.mockRejectedValue(new Error('parse error'));
    render(<Harness>{diagram}</Harness>);
    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalled());
    expect(screen.getByText(/graph TD/)).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Diagram' })).toBeNull();
  });
});

describe('math', () => {
  it('typesets inline $…$ math through katex', async () => {
    render(<Harness>{'Energy is $E=mc^2$ at rest.'}</Harness>);
    expect((await screen.findByTestId('katex')).textContent).toBe('E=mc^2');
    expect(katexMock.renderToString).toHaveBeenCalledWith(
      'E=mc^2',
      expect.objectContaining({ displayMode: false }),
    );
  });

  it('typesets display $$…$$ math in display mode', async () => {
    render(<Harness>{'$$\n\\sum_i x_i\n$$'}</Harness>);
    await screen.findByTestId('katex');
    expect(katexMock.renderToString).toHaveBeenCalledWith(
      expect.stringContaining('\\sum_i x_i'),
      expect.objectContaining({ displayMode: true }),
    );
  });

  it('shows the raw expression as inline code when it does not parse', async () => {
    katexMock.renderToString.mockImplementation(() => {
      throw new Error('KaTeX parse error');
    });
    render(<Harness>{'Broken $\\frac{1}$ here.'}</Harness>);
    await waitFor(() => expect(katexMock.renderToString).toHaveBeenCalled());
    const raw = screen.getByText('\\frac{1}');
    expect(raw.tagName).toBe('CODE');
    expect(screen.queryByTestId('katex')).toBeNull();
  });
});

describe('app links', () => {
  const id = '05341dbd-2f6a-4c1e-9a77-3f1e8b2c4d10';
  const appPath = `/apps/${id}`;

  afterEach(() => window.history.pushState(null, '', '/'));

  it.each([
    ['a bare invented host', `add fill-ups from the app at https://your-app-host${appPath}.`],
    ['a schemeless invented host', `Open your-app-host${appPath} now`],
    ['a real host of the other brand', `Open https://app.heybob.xyz${appPath} now`],
    ['a bare relative path', `Open ${appPath} now`],
    ['an angle-bracketed URL', `Open <https://your-app-host${appPath}> now`],
  ])('turns %s into one in-app link with no host on show', (_name, reply) => {
    const { container } = render(<Harness>{reply}</Harness>);
    expect(screen.getByRole('link', { name: 'Open app' }).getAttribute('href')).toBe(appPath);
    expect(container.textContent).not.toMatch(/your-app-host|bob\.app|\/apps\//);
  });

  it.each([
    ['an invented host', `[Fuel log](https://your-app-host${appPath})`, 'Fuel log'],
    ['a protocol-relative host', `[Fuel log](//evil.example${appPath})`, 'Fuel log'],
    ['the verbatim tool url', `[Fuel log](${appPath})`, 'Fuel log'],
    ['the URL as its own label', `[https://your-app-host${appPath}](https://your-app-host${appPath})`, 'Open app'],
  ])('keeps a markdown link on %s in-app', (_name, reply, label) => {
    render(<Harness>{reply}</Harness>);
    const link = screen.getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe(appPath);
    expect(link.getAttribute('target')).toBeNull();
  });

  it('opens the app inside the single-page app on the current host, keeping modified clicks for the browser', async () => {
    const routeChange = vi.fn();
    window.addEventListener('bob:routechange', routeChange);
    render(<Harness>{`Open https://your-app-host${appPath} now`}</Harness>);
    const link = screen.getByRole('link', { name: 'Open app' });
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true);
    expect(routeChange).not.toHaveBeenCalled();
    expect(fireEvent.click(link)).toBe(false);
    window.removeEventListener('bob:routechange', routeChange);
    expect(window.location.pathname).toBe(appPath);
    expect(routeChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another path', 'Read https://example.com/docs now', 'https://example.com/docs'],
    ['a deeper path', `Read https://example.com/apps/${id}/edit now`, `https://example.com/apps/${id}/edit`],
    ['a nested path', `Read https://example.com/org/apps/${id} now`, `https://example.com/org/apps/${id}`],
    ['a query', `Read https://example.com/apps/${id}?tab=1 now`, `https://example.com/apps/${id}?tab=1`],
    ['a non-id segment', 'Read https://example.com/apps/calculator now', 'https://example.com/apps/calculator'],
  ])('leaves an external link with %s untouched', (_name, reply, href) => {
    render(<Harness>{reply}</Harness>);
    const link = screen.getByRole('link', { name: href });
    expect(link.getAttribute('href')).toBe(href);
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('leaves app paths in code alone and still refuses a javascript link', () => {
    const { container } = render(<Harness>{`Run \`curl https://your-app-host${appPath}\`\n\n[bad](javascript:alert(1))`}</Harness>);
    expect(container.querySelector('code')?.textContent).toContain(`https://your-app-host${appPath}`);
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it.each([
    ['a sign-in link carrying the path', `[x](https://login.example/?next=${appPath})`, 'x', `https://login.example/?next=${appPath}`],
    ['the same link bare', `https://login.example/?next=${appPath}`, `https://login.example/?next=${appPath}`, `https://login.example/?next=${appPath}`],
    ['a hash route', `https://example.com/#${appPath}`, `https://example.com/#${appPath}`, `https://example.com/#${appPath}`],
    ['a nested URL', `https://example.com/?u=https://h${appPath}`, `https://example.com/?u=https://h${appPath}`, `https://example.com/?u=https://h${appPath}`],
    ['an app URL only as its label', `[https://h${appPath}](https://evil.example)`, `https://h${appPath}`, 'https://evil.example'],
    ['an app URL inside a longer label', `[see https://h${appPath} here](https://evil.example)`, `see https://h${appPath} here`, 'https://evil.example'],
    ['an app path as its label', `[${appPath}](https://evil.example)`, appPath, 'https://evil.example'],
  ])('leaves an external target on %s, one link, no friendly label', (_name, reply, label, href) => {
    render(<Harness>{reply}</Harness>);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe(label);
    expect(links[0]?.getAttribute('href')).toBe(href);
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toContain('noopener');
  });

  it('repairs a URL inside a longer label when the link itself is the app, as one link', () => {
    const { container } = render(<Harness>{`[see https://h${appPath} here](https://h${appPath})`}</Harness>);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe(appPath);
    expect(container.textContent).toBe('see Open app here');
  });

  it.each([
    ['a tilde fence', `~~~\ncurl https://h${appPath}\n~~~`],
    ['a double-backtick span', `Run \`\`curl \`x\` https://h${appPath}\`\` now`],
  ])('leaves %s alone', (_name, reply) => {
    const { container } = render(<Harness>{reply}</Harness>);
    expect(container.textContent).toContain(`https://h${appPath}`);
    expect(screen.queryByRole('link', { name: 'Open app' })).toBeNull();
  });

  it.each([
    ['a Windows path', `Saved in C:${appPath} today`],
    ['a parent path', `Saved in ..${appPath} today`],
    ['a mail address', `Mail mailto:a@b.example${appPath} today`],
  ])('does not treat %s as an app link', (_name, reply) => {
    const { container } = render(<Harness>{reply}</Harness>);
    expect(screen.queryByRole('link', { name: 'Open app' })).toBeNull();
    expect(container.textContent).toContain(appPath);
  });

  it.each([
    ['a Windows path', `[x](C:${appPath})`],
    ['a parent path', `[x](..${appPath})`],
  ])('does not repoint a markdown link to %s', (_name, reply) => {
    render(<Harness>{reply}</Harness>);
    expect(screen.getByRole('link', { name: 'x' }).getAttribute('href')).not.toBe(appPath);
  });

  it('leaves an image alone', () => {
    const { container } = render(<Harness>{`![chart](https://cdn.example${appPath})`}</Harness>);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`https://cdn.example${appPath}`);
    expect(screen.queryByRole('link', { name: 'Open app' })).toBeNull();
  });

  it('repairs the link in a reply while it streams', async () => {
    render(<Harness isStreaming>{`Open https://your-app-host${appPath} now`}</Harness>);
    expect((await screen.findByRole('link', { name: 'Open app' })).getAttribute('href')).toBe(appPath);
  });
});
