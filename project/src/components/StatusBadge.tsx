import type { VideoStatus } from '@/lib/supabase';
import { STATUS_COLORS, STATUS_LABELS, STATUS_ORDER } from '@/lib/supabase';

interface StatusBadgeProps {
  status: VideoStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_COLORS[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

interface StatusStepperProps {
  current: VideoStatus;
  onStepClick?: (status: VideoStatus) => void;
}

export function StatusStepper({ current, onStepClick }: StatusStepperProps) {
  const currentIndex = STATUS_ORDER.indexOf(current);

  return (
    <div className="flex items-center gap-1">
      {STATUS_ORDER.map((step, i) => {
        const isDone = i <= currentIndex;
        const isCurrent = i === currentIndex;
        return (
          <div key={step} className="flex items-center gap-1 flex-1 last:flex-none">
            <button
              type="button"
              disabled={!onStepClick}
              onClick={() => onStepClick?.(step)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                isCurrent
                  ? `${STATUS_COLORS[step]} shadow-sm`
                  : isDone
                    ? 'bg-ink-700 text-slate-300'
                    : 'bg-ink-800 text-ink-500'
              } ${onStepClick ? 'cursor-pointer hover:opacity-80' : 'cursor-default'}`}
            >
              {isDone && !isCurrent && <span className="w-1.5 h-1.5 rounded-full bg-success-400" />}
              {STATUS_LABELS[step]}
            </button>
            {i < STATUS_ORDER.length - 1 && (
              <div className={`h-px w-3 ${isDone ? 'bg-ink-600' : 'bg-ink-800'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
