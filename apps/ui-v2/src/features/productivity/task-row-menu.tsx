import { useCallback, useRef, useState, type MouseEvent, type ReactElement } from 'react';
import type { DropdownMenuOption } from '@astryxdesign/core/DropdownMenu';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { HStack } from '@astryxdesign/core/HStack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Text } from '@astryxdesign/core/Text';

/**
 * One overflow menu per row. Its items are built only while the menu is open,
 * so a long list mounts one trigger per row and no menu content until someone
 * opens it. `presentation="adaptive"` gives a thumb-reachable sheet on phones.
 * Group items by intent and keep a destructive item last.
 */
export function RowMenu({
  label,
  items,
}: {
  label: string;
  items: () => DropdownMenuOption[];
}): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <MoreMenu
      label={label}
      size="sm"
      alignment="end"
      presentation="adaptive"
      isMenuOpen={isOpen}
      onOpenChange={setIsOpen}
      items={isOpen ? items() : []}
    />
  );
}

/**
 * A row click handler that ignores clicks bubbling through React from content
 * portaled out of the row, such as the row's own open menu: without it, picking
 * "Delete" in the menu would also open the row.
 */
export function rowClick(open: () => void): (event: MouseEvent) => void {
  return (event) => {
    if (event.target instanceof Node && event.currentTarget.contains(event.target)) open();
  };
}

/**
 * Scrolls a deep-linked row (?task= / ?note=) into view once, the first time it
 * renders. Pass the returned ref to that row's ListItem only.
 */
export function useScrollOnce(): (el: HTMLElement | null) => void {
  const done = useRef(false);
  return useCallback((el: HTMLElement | null) => {
    if (el === null || done.current) return;
    done.current = true;
    el.scrollIntoView?.({ block: 'center' });
  }, []);
}

/** The one overdue mark for every task row: the status dot and the word, so
 *  the state never rests on colour alone. Pair it with `isDueOverdue`. */
export function TaskOverdueMark(): ReactElement {
  return (
    <HStack gap={1} vAlign="center">
      <StatusDot variant="error" label="Overdue" />
      <Text type="supporting" size="xsm">
        Overdue
      </Text>
    </HStack>
  );
}
