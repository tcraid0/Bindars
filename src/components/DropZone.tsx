import { memo } from "react";

interface DropZoneProps {
  visible: boolean;
}

function DropZoneComponent({ visible }: DropZoneProps) {
  if (!visible) return null;

  return (
    <div className="drop-zone-overlay">
      <div className="drop-zone-border text-center">
        <div className="text-text-muted mb-2">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>
        <p className="text-lg font-ui font-medium text-text-primary">Drop .md, .markdown, or .fountain file here</p>
        <p className="text-sm text-text-muted mt-1">Release to open</p>
      </div>
    </div>
  );
}

export const DropZone = memo(DropZoneComponent);
