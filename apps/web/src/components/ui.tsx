/**
 * Small shared primitives.
 *
 * Hand-written rather than generated, and deliberately few: a button, an input,
 * a field wrapper that renders validation errors, and a spinner. Enough to keep
 * the feature components free of repeated Tailwind strings without inventing a
 * component library nobody asked for.
 */

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { forwardRef } from 'react';

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  isLoading?: boolean;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-sky-600 text-white hover:bg-sky-500 disabled:hover:bg-sky-600',
  secondary:
    'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700 dark:hover:bg-slate-700',
  ghost:
    'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
  danger: 'bg-red-600 text-white hover:bg-red-500',
};

export function Button({
  variant = 'primary',
  isLoading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      // Disabling while a mutation is in flight is the cheapest possible guard
      // against double-submits - which for reminders would otherwise rely on the
      // server's dedupe key to absorb.
      disabled={disabled || isLoading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {isLoading && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cx(
        'inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent',
        className,
      )}
    />
  );
}

/* -------------------------------------------------------------------------- */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cx(
          'w-full rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-slate-300',
          'placeholder:text-slate-400 focus:ring-2 focus:ring-sky-500',
          'dark:bg-slate-800 dark:ring-slate-700 dark:placeholder:text-slate-500',
          className,
        )}
        {...rest}
      />
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cx(
          'w-full rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-slate-300',
          'placeholder:text-slate-400 focus:ring-2 focus:ring-sky-500',
          'dark:bg-slate-800 dark:ring-slate-700 dark:placeholder:text-slate-500',
          className,
        )}
        {...rest}
      />
    );
  },
);

/* -------------------------------------------------------------------------- */

interface FieldProps {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: string;
  children: ReactNode;
}

/**
 * Label + control + error message.
 *
 * aria-describedby wiring lives here so every form gets it right by default -
 * a validation message that is visually adjacent but not programmatically
 * associated is invisible to a screen reader.
 */
export function Field({ label, htmlFor, error, hint, children }: FieldProps) {
  const errorId = `${htmlFor}-error`;
  const hintId = `${htmlFor}-hint`;

  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={hintId} className="text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** Error banner for failures that are not tied to a single field. */
export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-900"
    >
      {message}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center dark:border-slate-700">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">{title}</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  );
}
