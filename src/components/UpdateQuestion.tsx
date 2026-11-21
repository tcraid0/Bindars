import { UPDATE_PRIVACY_NOTE } from "../lib/updates";

interface UpdateQuestionProps {
  visible: boolean;
  onAnswer: (turnOn: boolean) => void;
}

export function UpdateQuestion({ visible, onAnswer }: UpdateQuestionProps) {
  if (!visible) return null;
  return (
    <div role="region" aria-label="Updates" className="print-hide fixed bottom-4 right-4 z-40 max-w-sm rounded-lg border border-border bg-bg-secondary p-4 shadow-lg">
      <p className="text-sm font-semibold text-text-primary mb-1">Check for new versions automatically?</p>
      <p className="text-sm text-text-secondary mb-3">About once a day, Bindars would look for a newer version. {UPDATE_PRIVACY_NOTE}</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => onAnswer(false)} className="px-3 py-1.5 rounded-md text-sm text-text-secondary hover:bg-bg-tertiary transition-colors duration-120">No Thanks</button>
        <button type="button" onClick={() => onAnswer(true)} className="px-3 py-1.5 rounded-md text-sm text-text-primary border border-border hover:bg-bg-tertiary transition-colors duration-120">Turn On</button>
      </div>
    </div>
  );
}
