import { BRAND } from '@/lib/brand';
import type { ReactElement } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { VStack } from '@astryxdesign/core/VStack';

// One transient notice above the composer. Kept generic on purpose: copy
// failure, connection loss and save failure all render through the same region.
export type ChatNotice = {
  id: string;
  tone: 'info' | 'warning' | 'error';
  text: string;
  action?: { label: string; onPress: () => void };
};

// #1041: a spent AI budget, as web chat and web voice report it (out_of_credit).
// The device's card says the same (OUT_OF_CREDIT_REPLY in apps/api/src/voice/turn/failure.ts).
export const OUT_OF_CREDIT_NOTICE = `${BRAND.assistantName} needs a rest: the usage limit is reached.`;

// The live region stays mounted even when empty, so a notice that appears is
// announced rather than being present on first paint.
export function NoticeRegion({ notices }: { notices: ChatNotice[] }): ReactElement {
  return (
    <VStack gap={2} role="status" aria-live="polite">
      {notices.length > 0 && (
        <>
          {notices.map((notice) => (
            <Banner
              key={notice.id}
              status={notice.tone}
              title={notice.text}
              endContent={
                notice.action ? (
                  <Button
                    label={notice.action.label}
                    size="sm"
                    variant="secondary"
                    onClick={notice.action.onPress}
                  />
                ) : undefined
              }
            />
          ))}
        </>
      )}
    </VStack>
  );
}
