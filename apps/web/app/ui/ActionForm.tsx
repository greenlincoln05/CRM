'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import type { FormState } from '../actions';

/**
 * One wrapper for every write form in the app.
 *
 * It exists so the individual forms can stay as plain markup: the pending
 * state, the error line, the reset-on-success and the refresh all behave the
 * same way everywhere, which matters more than usual here because the person
 * using it is standing up with a customer waiting and should never have to
 * wonder whether a save landed.
 *
 * The error comes back from the server action, not from client-side validation.
 * The rules live in @lcp/db and are enforced there; duplicating them in the
 * browser would mean two definitions of a valid phone number and eventually two
 * different answers.
 */
export default function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  resetOnSuccess = false,
  destructive = false,
  compact = false,
  confirm,
  successPathPrefix,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  /** For repeated-entry forms - the note composer, the test panel. */
  resetOnSuccess?: boolean;
  destructive?: boolean;
  compact?: boolean;
  /** Shown in a confirm() before the action runs. */
  confirm?: string;
  /**
   * Navigate to `${successPathPrefix}${id}` when the action returns an id. A
   * string rather than a callback because props to a client component have to
   * survive serialization.
   */
  successPathPrefix?: string;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(action, {});
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (!state.ok) return;
    if (resetOnSuccess) formRef.current?.reset();

    if (successPathPrefix && state.id) {
      router.push(`${successPathPrefix}${state.id}`);
      return;
    }
    // The server action revalidated the path; this is what makes the new row
    // appear without a manual reload.
    router.refresh();
  }, [state, resetOnSuccess, router, successPathPrefix]);

  return (
    <form
      ref={formRef}
      action={formAction}
      className={compact ? 'actionform compact' : 'actionform'}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}

      {state.error && (
        <p className="formerror" role="alert">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        className={destructive ? 'danger' : 'primary'}
        disabled={pending}
      >
        {pending ? (pendingLabel ?? 'Saving…') : submitLabel}
      </button>
    </form>
  );
}
