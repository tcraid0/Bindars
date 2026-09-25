import { useCallback, useState, useEffect, useRef } from "react";
import type { HeadingItem } from "../types";
import {
  resolveActiveHeadingId,
  type ActiveHeadingOffset,
} from "../lib/active-heading";
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

interface HeadingObserverResult {
  activeId: string | null;
  setActiveId: (id: string | null, options?: { suppressObserverMs?: number }) => void;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
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
): HeadingObserverResult {
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const suppressObserverUntilRef = useRef(0);

  const topOffsetPx = options.topOffsetPx ?? ACTIVE_HEADING_TOP_PX;
  const hysteresisPx = options.hysteresisPx ?? ACTIVE_HEADING_HYSTERESIS_PX;
  const syncIntervalMs = options.syncIntervalMs ?? 50;
  const useIntersectionObserver = options.useIntersectionObserver ?? true;

  const setObservedActiveId = useCallback((nextId: string | null) => {
    if (activeIdRef.current === nextId) return;
    activeIdRef.current = nextId;
    setActiveId(nextId);
  }, []);

  const setExplicitActiveId = useCallback((
    nextId: string | null,
    options: { suppressObserverMs?: number } = {},
  ) => {
    const suppressObserverMs = Math.max(0, options.suppressObserverMs ?? 0);
    suppressObserverUntilRef.current = suppressObserverMs > 0
      ? nowMs() + suppressObserverMs
      : 0;
    setObservedActiveId(nextId);
  }, [setObservedActiveId]);

  useEffect(() => {
    if (headings.length === 0) {
      setObservedActiveId(null);
      return;
    }

    if (activeIdRef.current && !headings.some((heading) => heading.id === activeIdRef.current)) {
      setObservedActiveId(null);
    }

    const root = scrollRootRef.current;
    let scheduledFrame: number | null = null;
    let throttleTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSyncAt = 0;

    const headingEntries = headings
      .map((heading, index) => {
        const el = document.getElementById(heading.id);
        return { id: heading.id, el, index };
      })
      .filter((entry): entry is { id: string; el: HTMLElement; index: number } => entry.el instanceof HTMLElement);
    const headingOffsets: ActiveHeadingOffset[] = [];

    const getRootScrollTop = () => {
      if (root) return root.scrollTop;
      return window.scrollY || window.pageYOffset || 0;
    };

    const getScrollMetrics = () => {
      if (root) {
        return {
          scrollTop: root.scrollTop,
          clientHeight: root.clientHeight,
          scrollHeight: root.scrollHeight,
        };
      }

      const documentElement = document.documentElement;
      const body = document.body;
      return {
        scrollTop: window.scrollY || window.pageYOffset || 0,
        clientHeight: window.innerHeight || documentElement.clientHeight || 0,
        scrollHeight: Math.max(
          documentElement.scrollHeight,
          body?.scrollHeight ?? 0,
        ),
      };
    };

    const recomputeOffsets = () => {
      const rootTop = root?.getBoundingClientRect().top ?? 0;
      const rootScrollTop = getRootScrollTop();
      headingOffsets.length = 0;
      for (const entry of headingEntries) {
        headingOffsets.push({
          id: entry.id,
          offsetTop: entry.el.getBoundingClientRect().top - rootTop + rootScrollTop,
        });
      }
      const indexById = new Map(headingEntries.map((entry) => [entry.id, entry.index]));
      headingOffsets.sort((a, b) =>
        a.offsetTop - b.offsetTop || (indexById.get(a.id) ?? 0) - (indexById.get(b.id) ?? 0),
      );
    };

    const getVisibleHeadingId = () => {
      return resolveActiveHeadingId({
        headingOffsets,
        ...getScrollMetrics(),
        topOffsetPx,
        hysteresisPx,
        currentId: activeIdRef.current,
      });
    };

    const runSync = () => {
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = null;
        lastSyncAt = Date.now();
        recomputeOffsets();
        // Keep explicit smooth-scroll navigation visually stable; passive scroll
        // tracking resumes as soon as this short window expires.
        if (nowMs() < suppressObserverUntilRef.current) {
          return;
        }
        suppressObserverUntilRef.current = 0;
        setObservedActiveId(getVisibleHeadingId());
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
  }, [headings, scrollRootRef, topOffsetPx, hysteresisPx, syncIntervalMs, useIntersectionObserver, setObservedActiveId]);

  return { activeId, setActiveId: setExplicitActiveId };
}
