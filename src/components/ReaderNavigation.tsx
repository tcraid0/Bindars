import { forwardRef, memo, useImperativeHandle, useLayoutEffect } from "react";
import type { RefObject } from "react";
import { useHeadingObserver } from "../hooks/useHeadingObserver";
import { TableOfContents } from "./TableOfContents";
import type { TableOfContentsProps } from "./TableOfContents";

interface SetActiveHeadingOptions {
  suppressObserverMs?: number;
}

export interface ReaderNavigationHandle {
  setActiveId: (id: string | null, options?: SetActiveHeadingOptions) => void;
}

interface ReaderNavigationProps extends Omit<TableOfContentsProps, "activeId"> {
  scrollRootRef: RefObject<HTMLElement | null>;
  syncIntervalMs: number;
  useIntersectionObserver: boolean;
  onActiveHeadingChange: (id: string | null) => void;
}

const ReaderNavigationComponent = forwardRef<ReaderNavigationHandle, ReaderNavigationProps>(
  function ReaderNavigationComponent({
    headings,
    scrollRootRef,
    syncIntervalMs,
    useIntersectionObserver,
    onActiveHeadingChange,
    ...tocProps
  }, ref) {
    const { activeId, setActiveId } = useHeadingObserver(headings, scrollRootRef, {
      syncIntervalMs,
      useIntersectionObserver,
    });

    useImperativeHandle(ref, () => ({ setActiveId }), [setActiveId]);

    useLayoutEffect(() => {
      onActiveHeadingChange(activeId);
    }, [activeId, onActiveHeadingChange]);

    return (
      <TableOfContents
        {...tocProps}
        headings={headings}
        activeId={activeId}
      />
    );
  },
);

export const ReaderNavigation = memo(ReaderNavigationComponent);
