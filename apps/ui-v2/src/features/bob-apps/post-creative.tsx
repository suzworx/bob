import { useEffect, useRef, useState, type ReactElement } from 'react';
import '@fontsource/nunito/700.css';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { CREATIVE_SPECS, canvasToPngFile, loadCreativeArt, paintCreative, type CreativeChannel } from './post-creative-render';
import { PreparedImage } from './prepared-image';

type PostCreativeProps = { text: string; channel: CreativeChannel; artUrl: string };

function Creative({ text, channel, artUrl }: PostCreativeProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const art = await loadCreativeArt(channel, text, artUrl);
        const canvas = canvasRef.current;
        if (!live || !canvas) return;
        paintCreative(canvas, channel, text, art);
        const png = await canvasToPngFile(canvas, channel);
        if (live) setFile(png);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => { live = false; };
  }, [text, channel, artUrl, attempt]);

  if (failed) {
    return <Banner status="error" title="Bob couldn't draw this image" description="Your post is safe. Give it another go." endContent={<Button label="Try again" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }} />} />;
  }
  const { width, height } = CREATIVE_SPECS[channel];
  return <>
    {/* Canvas is the one non-Astryx element: it is what produces the image file. */}
    <canvas hidden aria-hidden ref={canvasRef} width={width} height={height} />
    <PreparedImage file={file} alt={`Image of Bob for this post: ${text}`} />
  </>;
}

/** A finished, shareable post image. A new post, channel or art starts fresh. */
export function PostCreative(props: PostCreativeProps): ReactElement {
  return <Creative key={`${props.channel}\n${props.artUrl}\n${props.text}`} {...props} />;
}
