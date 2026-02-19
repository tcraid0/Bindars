import { useState, useEffect, useRef } from "react";
import type { HeadingItem } from "../types";
import {
  ACTIVE_HEADING_HYSTERESIS_PX,
  ACTIVE_HEADING_TOP_PX,
} from "../lib/scroll-constants";

interface HeadingObserverOptions {
  topOffsetPx?: number;
  hysteresisPx?: number;
  syncIntervalMs?: number;
  useIntersectionObserver?: boolean;
}

/**
 * Track the active heading for the reader scroll container.
 * Uses IntersectionObserver to trigger updates and a deterministic
 * top-threshold scan to keep heading state stable while scrolling.
 */
export function useHeadingObserver(
  headings: HeadingItem[],
  scrollRootRef: React.RefObject<HTMLElement | null>,
  options: HeadingObserverOptions = {},
): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);

  const topOffsetPx = options.topOffsetPx ?? ACTIVE_HEADING_TOP_PX;
  const hysteresisPx = options.hysteresisPx ?? ACTIVE_HEADING_HYSTERESIS_PX;
  const syncIntervalMs = options.syncIntervalMs ?? 50;
  const useIntersectionObserver = options.useIntersectionObserver ?? true;

  useEffect(() => {
    if (headings.length === 0) {
      activeIdRef.current = null;
      setActiveId(null);
      return;
    }

    if (activeIdRef.current && !headings.some((heading) => heading.id === activeIdRef.current)) {
      activeIdRef.current = null;
      setActiveId(null);
    }

    const root = scrollRootRef.current;
    let scheduledFrame: number | null = null;
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSyncAt = 0;

    const headingEntries = headings
      .map((heading) => {
        const el = document.getElementById(heading.id);
        return { id: heading.id, el };
      })
      .filter((entry): entry is { id: string; el: HTMLElement } => entry.el instanceof HTMLElement);
    const headingOffsets = headingEntries.map((entry) => ({ ...entry, offsetTop: 0 }));
    const offsetById = new Map<string, number>();

    const getRootScrollTop = () => {
      if (root) return root.scrollTop;
      return window.scrollY || window.pageYOffset || 0;
    };

    const recomputeOffsets = () => {
      const rootTop = root?.getBoundingClientRect().top ?? 0;
      const rootScrollTop = getRootScrollTop();
      offsetById.clear();
      for (const entry of headingOffsets) {
        entry.offsetTop = entry.el.getBoundingClientRect().top - rootTop + rootScrollTop;
        offsetById.set(entry.id, entry.offsetTop);
      }
    };

    const findVisibleHeadingId = (thresholdScrollTop: number): string | null => {
      if (headingOffsets.length === 0) return headings[0]?.id ?? null;

      let left = 0;
      let right = headingOffsets.length - 1;
      let best = 0;

      while (left <= right) {
        const mid = (left + right) >> 1;
        if (headingOffsets[mid].offsetTop <= thresholdScrollTop) {
          best = mid;
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }

      return headingOffsets[best]?.id ?? headings[0]?.id ?? null;
    };

    const getVisibleHeadingId = () => {
      const thresholdScrollTop = getRootScrollTop() + topOffsetPx;
      return findVisibleHeadingId(thresholdScrollTop);
    };

    const commitActiveId = (nextId: string | null) => {
      if (!nextId) {
        if (activeIdRef.current !== null) {
          activeIdRef.current = null;
          setActiveId(null);
        }
        return;
      }

      const currentId = activeIdRef.current;
      if (!currentId || currentId === nextId || hysteresisPx <= 0) {
        if (currentId !== nextId) {
          activeIdRef.current = nextId;
          setActiveId(nextId);
        }
        return;
      }

      const thresholdScrollTop = getRootScrollTop() + topOffsetPx;
      const currentOffset = offsetById.get(currentId);
      const nextOffset = offsetById.get(nextId);
      if (typeof currentOffset !== "number" || typeof nextOffset !== "number") {
        activeIdRef.current = nextId;
        setActiveId(nextId);
        return;
      }

      const currentDistance = Math.abs(currentOffset - thresholdScrollTop);
      const nextDistance = Math.abs(nextOffset - thresholdScrollTop);

      if (nextDistance + hysteresisPx < currentDistance) {
        activeIdRef.current = nextId;
        setActiveId(nextId);
      }
    };

    const runSync = () => {
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = null;
        lastSyncAt = Date.now();
        commitActiveId(getVisibleHeadingId());
      });
    };

    const scheduleSync = () => {
      if (scheduledFrame !== null) {
        return;
      }

      const now = Date.now();
      const wait = syncIntervalMs - (now - lastSyncAt);
      if (wait > 0) {
        if (throttleTimer !== null) return;
        throttleTimer = setTimeout(() => {
          throttleTimer = null;
          if (scheduledFrame === null) runSync();
        }, wait);
        return;
      }

      runSync();
    };

    const observer = useIntersectionObserver
      ? new IntersectionObserver(
          () => scheduleSync(),
          {
            root,
            rootMargin: `-${topOffsetPx}px 0px -75% 0px`,
            threshold: [0, 1],
          },
        )
      : null;

    const elements: Element[] = [];
    if (observer) {
      for (const entry of headingEntries) {
        observer.observe(entry.el);
        elements.push(entry.el);
      }
    }

    const resizeObserver =
      typeof ResizeObserver !== "undefined" && root
        ? new ResizeObserver(() => {
            recomputeOffsets();
            scheduleSync();
          })
        : null;
    if (resizeObserver && root) {
      resizeObserver.observe(root);
    }

    const scrollTarget: EventTarget = root ?? window;
    const handleResize = () => {
      recomputeOffsets();
      scheduleSync();
    };
    recomputeOffsets();
    scrollTarget.addEventListener("scroll", scheduleSync, { passive: true });
    window.addEventListener("resize", handleResize);

    scheduleSync();

    return () => {
      scrollTarget.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", handleResize);

      if (scheduledFrame !== null) {
        cancelAnimationFrame(scheduledFrame);
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer);
      }

      if (resizeObserver) {
        resizeObserver.disconnect();
      }

      if (observer) {
        for (const el of elements) {
          observer.unobserve(el);
        }
        observer.disconnect();
      }
    };
  }, [headings, scrollRootRef, topOffsetPx, hysteresisPx, syncIntervalMs, useIntersectionObserver]);

  return activeId;
}
