import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Banner } from '@astryxdesign/core/Banner';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { VStack } from '@astryxdesign/core/VStack';
import { useActiveTheme } from '@/app/theme-choice';
import { AppRenderer, type AppViewSelection } from './app-renderer';
import { exportApp, getApp, type BobApp } from './bob-apps-api';
import { captureAppViewImage, ImageCaptureError } from './app-view-image-capture';
import { PreparedImage } from './prepared-image';

type Props = { app: BobApp; userId: string; selection: AppViewSelection; onClose: () => void };

function sameApp(expected: BobApp, fresh: BobApp): boolean {
  return expected.id === fresh.id && expected.installationId === fresh.installationId && expected.spaceId === fresh.spaceId && expected.revision === fresh.revision;
}

async function verifiedCapture(app: BobApp, element: HTMLElement, controller: AbortController, valid: () => boolean): Promise<Blob | null> {
  const before = await getApp(app.id, controller.signal);
  if (!valid()) return null;
  if (!sameApp(app, before)) throw new Error('image_source_changed');
  const result = await captureAppViewImage(element, { signal: controller.signal });
  if (!valid()) return null;
  const after = await getApp(app.id, controller.signal);
  if (!valid()) return null;
  if (!sameApp(app, after)) throw new Error('image_source_changed');
  return result.blob;
}

function ImagePreview({ app, selection, onClose }: Props): ReactElement {
  const region = useRef<HTMLDivElement>(null);
  const active = useRef<AbortController | null>(null);
  const deadline = useRef<number | undefined>(undefined);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<'failed' | 'too_large' | null>(null);
  const [busy, setBusy] = useState(false);
  const invalidate = (): void => { window.clearTimeout(deadline.current); active.current?.abort(); active.current = null; setFile(null); setBusy(false); };
  useEffect(() => {
    const element = region.current;
    if (!element) return;
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const next = element.getBoundingClientRect().width;
      if (next !== width) { width = next; invalidate(); }
    });
    observer.observe(element);
    return () => { observer.disconnect(); window.clearTimeout(deadline.current); active.current?.abort(); active.current = null; };
  }, []);
  const close = (open: boolean): void => { if (!open) { invalidate(); onClose(); } };
  const fail = (problem: unknown, controller: AbortController): void => {
    if (controller.signal.aborted || active.current !== controller) return;
    setError(problem instanceof ImageCaptureError && problem.code === 'too_large' ? 'too_large' : 'failed');
  };
  const expire = (controller: AbortController): void => {
    if (active.current !== controller) return;
    invalidate(); setError('failed');
  };
  const prepare = async (): Promise<void> => {
    const element = region.current;
    if (!element || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setFile(null); setError(null); setBusy(true);
    const width = element.getBoundingClientRect().width;
    const viewport = `${window.innerWidth}:${window.innerHeight}`;
    const valid = (): boolean => active.current === controller && !controller.signal.aborted && element.getBoundingClientRect().width === width && `${window.innerWidth}:${window.innerHeight}` === viewport;
    const timer = window.setTimeout(() => expire(controller), 8_000);
    deadline.current = timer;
    try {
      const blob = await verifiedCapture(app, element, controller, valid);
      if (blob && valid()) setFile(new File([blob], 'bob-app-view.png', { type: 'image/png' }));
    } catch (problem) {
      fail(problem, controller);
    } finally {
      window.clearTimeout(timer);
      if (active.current === controller) { active.current = null; setBusy(false); }
    }
  };
  return <Dialog isOpen width={800} onOpenChange={close}>
    <Layout height="fill" header={<DialogHeader title="Share saved view" onOpenChange={close} />} content={<LayoutContent isScrollable>
      <VStack gap={4}>
        <VStack ref={region} gap={4} role="region" aria-label="Saved view image preview">
          <Heading level={2}>{app.definition.title}</Heading>
          <AppRenderer definition={app.definition} state={app.state} metrics={app.metrics} selection={selection} presentation="image" />
        </VStack>
      </VStack>
    </LayoutContent>} footer={<LayoutFooter hasDivider><VStack gap={3}>
      {error && <Banner status="error" title={error === 'too_large' ? 'This view is too large for one image. Export JSON to keep all its saved data.' : 'Couldn’t prepare this image. Your app is safe. Reload this page before trying again.'} endContent={error === 'too_large' ? <Button label="Export JSON" onClick={() => { void exportApp(app).catch(() => setError('failed')); }} /> : undefined} />}
      {file
        ? <PreparedImage file={file} alt={`Saved ${app.definition.title} view`} allowExpand={false} />
        : <Button label="Prepare image" isLoading={busy} isDisabled={busy} onClick={() => { void prepare(); }} />}
    </VStack></LayoutFooter>} />
  </Dialog>;
}

/** A new audience, saved revision, selected view or theme invalidates prepared output. */
export function AppViewImage(props: Props): ReactElement {
  const theme = useActiveTheme();
  const { isMobile } = useAppShellMobile();
  const identity = JSON.stringify([props.userId, props.app.id, props.app.installationId, props.app.spaceId, props.app.revision, props.selection.viewId, props.selection.slideIndex, theme.id, isMobile]);
  return <ImagePreview key={identity} {...props} />;
}
