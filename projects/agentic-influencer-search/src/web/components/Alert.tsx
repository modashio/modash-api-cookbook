import type { ReactNode } from 'react';

const VARIANT = {
  error: 'border-bad-border bg-bad-soft text-bad-text',
  muted: 'border-border-soft bg-bg-input text-text-dim',
} as const;

export function Alert({ variant, children }: { variant: keyof typeof VARIANT; children: ReactNode }) {
  return (
    <p
      className={`mt-2.5 mb-0 rounded-sm border px-2.5 py-2 text-xs ${VARIANT[variant]}`}
      role={variant === 'error' ? 'alert' : undefined}
    >
      {children}
    </p>
  );
}
