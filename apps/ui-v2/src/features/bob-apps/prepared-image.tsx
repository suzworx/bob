import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Thumbnail } from '@astryxdesign/core/Thumbnail';
import { Lightbox } from '@astryxdesign/core/Lightbox';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { VStack } from '@astryxdesign/core/VStack';
import { chooseDelivery, downloadFile, shareFile } from './post-creative-render';

type Props = { file: File | null; alt: string; label?: string; allowExpand?: boolean };

/** Delivery starts from a prepared file, preserving the native share gesture. */
export function PreparedImage({ file, alt, label = 'Preview image', allowExpand = true }: Props): ReactElement {
  const [failedFile, setFailedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const [viewingFile, setViewingFile] = useState<File | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    ++generation.current;
    setFailedFile(null);
    setViewingFile(null);
    const url = file ? URL.createObjectURL(file) : null;
    setPreview(file && url ? { file, url } : null);
    return () => { ++generation.current; if (url) URL.revokeObjectURL(url); };
  }, [file]);
  const url = preview?.file === file ? preview.url : undefined;
  const shareFailed = file !== null && failedFile === file;
  const share = file !== null && !shareFailed && chooseDelivery(navigator, file) === 'share';
  const deliver = (ready: File): void => {
    const current = generation.current;
    void shareFile(navigator, ready).then((result) => {
      if (current === generation.current) setFailedFile(result === 'failed' ? ready : null);
    });
  };
  return <VStack gap={3}>
    {shareFailed && <Banner status="warning" title="Sharing didn't work here" description="You can download the image instead." />}
    <Thumbnail src={url} alt={alt} label={label} isLoading={!url} isDisabled={!url} onClick={allowExpand ? () => setViewingFile(file) : undefined} />
    {url && allowExpand && <Lightbox isOpen={viewingFile === file} onOpenChange={(open) => setViewingFile(open ? file : null)} media={{ type: 'image', src: url, alt }} />}
    {share
      ? <Button label="Share image" onClick={() => deliver(file)} />
      : <Button label="Download image" isLoading={file === null} onClick={() => { if (file) downloadFile(file); }} />}
  </VStack>;
}
