'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { signInAction, type FormState } from '../actions';

/**
 * Sign-in, built for the same counter as the search box.
 *
 * Email is remembered by the browser and the PIN field is focused on load, so
 * the common case - the same two people, several times a day, one of them
 * standing up - is four keystrokes and Enter.
 *
 * There is no success branch here. The action redirects from the server once
 * the session cookie is set, which is both simpler and the only way to land on
 * the page the person originally asked for: a client-side push would race the
 * refresh that picks up the new session.
 */
export default function LoginForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(signInAction, {});
  const next = useSearchParams().get('next') ?? '';
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => { pinRef.current?.focus(); }, []);

  return (
    <form action={action} className="card login">
      <h3>Sign in</h3>

      {/* Where middleware was taking them before it asked who they were. The
          server validates this; a value from a query string is not trusted to
          be a same-site path just because it arrived in one. */}
      <input type="hidden" name="next" value={next} />

      <label className="field">
        <span>Email</span>
        <input
          name="email"
          type="email"
          autoComplete="username"
          spellCheck={false}
          required
          aria-invalid={state.field === 'email'}
        />
      </label>

      <label className="field">
        <span>PIN</span>
        <input
          ref={pinRef}
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          required
          aria-invalid={state.field === 'pin'}
        />
      </label>

      {state.error && <p className="formerror" role="alert">{state.error}</p>}

      <button type="submit" className="primary" disabled={pending}>
        {pending ? 'Checking…' : 'Sign in'}
      </button>
    </form>
  );
}
