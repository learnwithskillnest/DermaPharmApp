import type { ReactNode } from 'react';
import { Checkbox, Form, FormErrors, TextField, type Errors, type Values } from '../forms.tsx';

function AuthShell({ title, intro, children, aside }: { title: string; intro?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="wrap grid max-w-5xl gap-12 py-10 md:grid-cols-[1fr_18rem] md:py-16">
      <div className="max-w-md">
        <h1 className="text-3xl">{title}</h1>
        {intro ? <p className="mt-2 text-[var(--color-muted)]">{intro}</p> : null}
        <div className="mt-8">{children}</div>
      </div>
      {aside ? <aside className="hidden self-start rounded-2xl bg-[var(--color-mint-50)] p-6 text-sm md:block">{aside}</aside> : null}
    </div>
  );
}

const WHY = (
  <>
    <h2 className="mb-3 text-base">With an account you can</h2>
    <ul className="grid gap-2 text-[var(--color-muted)]">
      <li>Track orders and request returns</li>
      <li>Save addresses for faster checkout</li>
      <li>Keep a wishlist</li>
      <li>Upload prescriptions for pharmacist review</li>
    </ul>
  </>
);

export function LoginPage({ errors, values, next }: { errors?: Errors; values?: Values; next: string }) {
  return (
    <AuthShell
      title="Sign in"
      intro={
        <>
          New here?{' '}
          <a className="link" href={`/register${next !== '/account' ? `?next=${encodeURIComponent(next)}` : ''}`}>
            Create an account
          </a>
        </>
      }
      aside={WHY}
    >
      <Form action="/login" className="grid gap-5" ariaLabel="Sign in">
        <input type="hidden" name="next" value={next} />
        <FormErrors errors={errors} />
        <TextField name="email" label="Email" type="email" required autoComplete="email" value={values?.email} errors={errors} />
        <TextField name="password" label="Password" type="password" required autoComplete="current-password" errors={errors} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="submit" className="btn btn-primary">
            Sign in
          </button>
          <a className="link text-sm" href="/forgot-password">
            Forgot your password?
          </a>
        </div>
      </Form>
    </AuthShell>
  );
}

export function RegisterPage({ errors, values, next }: { errors?: Errors; values?: Values; next: string }) {
  return (
    <AuthShell
      title="Create an account"
      intro={
        <>
          Already have one?{' '}
          <a className="link" href="/login">
            Sign in
          </a>
        </>
      }
      aside={WHY}
    >
      <Form action="/register" className="grid gap-5" ariaLabel="Create an account">
        <input type="hidden" name="next" value={next} />
        <FormErrors errors={errors} />
        <TextField name="name" label="Full name" required autoComplete="name" value={values?.name} errors={errors} maxLength={80} />
        <TextField name="email" label="Email" type="email" required autoComplete="email" value={values?.email} errors={errors} />
        <TextField name="phone" label="Mobile number" type="tel" autoComplete="tel" inputMode="tel" value={values?.phone} errors={errors} hint="For delivery updates." />
        <TextField
          name="password"
          label="Password"
          type="password"
          required
          autoComplete="new-password"
          errors={errors}
          hint="At least 10 characters, mixing letters with numbers or symbols."
        />
        <TextField name="confirm" label="Confirm password" type="password" required autoComplete="new-password" errors={errors} />
        <Checkbox
          name="terms"
          errors={errors}
          checked={values?.terms === 'on'}
          label={
            <>
              I accept the{' '}
              <a className="link" href="/policies/terms" target="_blank">
                terms of use
              </a>{' '}
              and{' '}
              <a className="link" href="/policies/privacy" target="_blank">
                privacy policy
              </a>
              .
            </>
          }
        />
        <Checkbox name="marketing" checked={values?.marketing === 'on'} label="Email me occasional offers. You can unsubscribe at any time." />
        <div>
          <button type="submit" className="btn btn-primary">
            Create account
          </button>
        </div>
      </Form>
    </AuthShell>
  );
}

export function ForgotPage({ errors, values, sent }: { errors?: Errors; values?: Values; sent?: boolean }) {
  return (
    <AuthShell title="Reset your password" intro="Enter your account email and we’ll send a link to choose a new password.">
      {sent ? (
        <div className="notice notice-success" role="status">
          If an account exists for that email, a reset link is on its way. It expires in 1 hour.
        </div>
      ) : (
        <Form action="/forgot-password" className="grid gap-5" ariaLabel="Request a password reset">
          <FormErrors errors={errors} />
          <TextField name="email" label="Email" type="email" required autoComplete="email" value={values?.email} errors={errors} />
          <div>
            <button type="submit" className="btn btn-primary">
              Send reset link
            </button>
          </div>
        </Form>
      )}
    </AuthShell>
  );
}

export function ResetPage({ token, errors }: { token: string; errors?: Errors }) {
  return (
    <AuthShell title="Choose a new password">
      <Form action="/reset-password" className="grid gap-5" ariaLabel="Choose a new password">
        <input type="hidden" name="token" value={token} />
        <FormErrors errors={errors} />
        <TextField
          name="password"
          label="New password"
          type="password"
          required
          autoComplete="new-password"
          errors={errors}
          hint="At least 10 characters, mixing letters with numbers or symbols."
        />
        <TextField name="confirm" label="Confirm new password" type="password" required autoComplete="new-password" errors={errors} />
        <div>
          <button type="submit" className="btn btn-primary">
            Save new password
          </button>
        </div>
      </Form>
    </AuthShell>
  );
}
