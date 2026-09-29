/**
 * Login and signup.
 *
 * Both forms validate with the SAME zod schemas the Express routes use
 * (loginSchema, signupSchema from @usage/shared). The password length
 * rule is written once; the client enforces it for instant feedback and the
 * server enforces it because a client check is a convenience, never a control.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from 'react-router-dom';
import { loginSchema, signupSchema, type LoginInput, type SignupInput } from '@usage/shared';
import { useAuth } from '../../lib/auth.js';
import { ApiRequestError } from '../../lib/api.js';
import { Button, ErrorBanner, Field, Input } from '../../components/ui.js';

function AuthShell({ title, subtitle, children, footer }: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
          {children}
        </div>
        <p className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">{footer}</p>
      </div>
    </div>
  );
}

/**
 * Map a server error onto the form.
 *
 * The API returns field-level messages for a 422, so they are attached to the
 * matching inputs; anything else becomes a banner. This is what makes "that
 * email is already registered" appear under the email box rather than as a
 * generic failure at the top.
 */
function useServerErrors<T extends Record<string, unknown>>(
  setError: ReturnType<typeof useForm<T>>['setError'],
) {
  const [banner, setBanner] = useState<string | null>(null);

  const handle = (err: unknown): void => {
    if (err instanceof ApiRequestError && err.fields) {
      let attached = false;
      for (const [field, message] of Object.entries(err.fields)) {
        setError(field as never, { type: 'server', message });
        attached = true;
      }
      if (attached) {
        setBanner(null);
        return;
      }
    }
    setBanner(err instanceof Error ? err.message : 'Something went wrong. Try again.');
  };

  return { banner, setBanner, handle };
}

/* -------------------------------------------------------------------------- */

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  const { banner, setBanner, handle } = useServerErrors<LoginInput>(setError);

  const onSubmit = handleSubmit(async (values) => {
    setBanner(null);
    try {
      await login(values.email, values.password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      handle(err);
    }
  });

  return (
    <AuthShell
      title="API Usage"
      subtitle="Sign in to your dashboard"
      footer={
        <>
          No account?{' '}
          <Link to="/signup" className="font-medium text-sky-600 hover:underline dark:text-sky-400">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorBanner message={banner} />

        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            autoFocus
            aria-invalid={Boolean(errors.email)}
            {...register('email')}
          />
        </Field>

        <Field label="Password" htmlFor="password" error={errors.password?.message}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={Boolean(errors.password)}
            {...register('password')}
          />
        </Field>

        <Button type="submit" isLoading={isSubmitting} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}

/* -------------------------------------------------------------------------- */

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({ resolver: zodResolver(signupSchema) });

  const { banner, setBanner, handle } = useServerErrors<SignupInput>(setError);

  const onSubmit = handleSubmit(async (values) => {
    setBanner(null);
    try {
      await signup(values.name, values.email, values.password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      handle(err);
    }
  });

  return (
    <AuthShell
      title="Create an account"
      subtitle="Start tracking your API spend"
      footer={
        <>
          Already have one?{' '}
          <Link to="/login" className="font-medium text-sky-600 hover:underline dark:text-sky-400">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <ErrorBanner message={banner} />

        <Field label="Name" htmlFor="name" error={errors.name?.message}>
          <Input id="name" autoComplete="name" autoFocus {...register('name')} />
        </Field>

        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...register('email')} />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          error={errors.password?.message}
          hint="At least 10 characters. Length beats complexity."
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...register('password')}
          />
        </Field>

        <Button type="submit" isLoading={isSubmitting} className="w-full">
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
