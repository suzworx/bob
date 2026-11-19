import type { ReactElement, SVGProps } from 'react';
import { BRAND } from '@/lib/brand';

// Bob's face inside an SVG, so it plugs into Astryx <Icon icon={BrandMark}> and NavIcon like a lucide
// icon; Icon sizes it, and it is decorative unless the caller gives it a label.
export function BrandMark(props: SVGProps<SVGSVGElement>): ReactElement {
  // Icon adds role="img" and aria-label for a labelled mark, which must stay
  // visible to assistive tech, so only an unlabelled mark defaults to hidden.
  const decorative = props['aria-label'] === undefined;
  return (
    <svg width={24} height={24} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden={decorative ? true : undefined} {...props}>
      <image xlinkHref={BRAND.markSrc} width="24" height="24" />
    </svg>
  );
}
