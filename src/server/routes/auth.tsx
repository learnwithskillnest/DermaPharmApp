import type { App } from '../app.ts';
import { safeNext } from '../http/context.ts';
import { HttpError, UserFacingError } from '../http/errors.ts';
import { render } from '../render.tsx';
import { signIn, signOut } from '../auth/session.ts';
import { authenticate, registerUser, requestPasswordReset, resetPassword } from '../services/users.ts';
import { forgotSchema, loginSchema, parseWith, registerSchema, resetSchema } from '../validation.ts';
import { ForgotPage, LoginPage, RegisterPage, ResetPage } from '../../ui/pages/auth.tsx';
import { echo } from './helpers.ts';

export function authRoutes(app: App) {
  const r = app.router;

  r.get('/login', async (ctx) => {
    if (ctx.user) return ctx.redirect(safeNext(ctx.query.get('next'), '/account'));
    await render(ctx, { title: 'Sign in', noindex: true }, <LoginPage next={safeNext(ctx.query.get('next'), '/account')} />);
  });

  r.post(
    '/login',
    async (ctx) => {
      const next = safeNext(ctx.form.next, '/account');
      const v = parseWith(loginSchema, ctx.form);
      if (!v.ok) return render(ctx, { title: 'Sign in' }, <LoginPage next={next} errors={v.errors} values={echo(ctx.form)} />, { status: 422 });
      // Per-account limit on top of the per-IP route limit (slows credential stuffing against one account).
      const retry = ctx.app.limiter.hit('login', v.data.email);
      if (retry) throw new HttpError(429, 'Too many sign-in attempts for this account. Wait a few minutes or reset your password.');
      try {
        const user = await authenticate(ctx.app.db, v.data.email, v.data.password);
        await signIn(ctx, user);
        ctx.app.limiter.reset('login', v.data.email);
        ctx.setFlash('success', `Welcome back, ${user.name.split(' ')[0]}.`);
        const dest = next === '/account' && user.role !== 'customer' ? '/admin' : next;
        return ctx.redirect(dest);
      } catch (e) {
        if (e instanceof UserFacingError) {
          return render(ctx, { title: 'Sign in' }, <LoginPage next={next} errors={{ _form: e.message }} values={{ email: v.data.email }} />, { status: e.status });
        }
        throw e;
      }
    },
    { rateLimit: 'loginIp' },
  );

  r.post('/logout', async (ctx) => {
    await signOut(ctx);
    ctx.setFlash('info', 'You have signed out.');
    ctx.redirect('/');
  });

  r.get('/register', async (ctx) => {
    if (ctx.user) return ctx.redirect('/account');
    await render(ctx, { title: 'Create an account', noindex: true }, <RegisterPage next={safeNext(ctx.query.get('next'), '/account')} />);
  });

  r.post(
    '/register',
    async (ctx) => {
      const next = safeNext(ctx.form.next, '/account');
      const v = parseWith(registerSchema, ctx.form);
      if (!v.ok) return render(ctx, { title: 'Create an account' }, <RegisterPage next={next} errors={v.errors} values={echo(ctx.form)} />, { status: 422 });
      try {
        const user = await registerUser(ctx.app.db, v.data);
        await signIn(ctx, user);
        ctx.setFlash('success', 'Your account is ready.');
        return ctx.redirect(next);
      } catch (e) {
        if (e instanceof UserFacingError) {
          const field = e.code === 'password' ? 'password' : e.code === 'email_taken' ? 'email' : '_form';
          return render(ctx, { title: 'Create an account' }, <RegisterPage next={next} errors={{ [field]: e.message }} values={echo(ctx.form)} />, { status: 422 });
        }
        throw e;
      }
    },
    { rateLimit: 'register' },
  );

  r.get('/forgot-password', async (ctx) => render(ctx, { title: 'Reset your password', noindex: true }, <ForgotPage sent={ctx.query.get('sent') === '1'} />));
  r.post(
    '/forgot-password',
    async (ctx) => {
      const v = parseWith(forgotSchema, ctx.form);
      if (!v.ok) return render(ctx, { title: 'Reset your password' }, <ForgotPage errors={v.errors} values={echo(ctx.form)} />, { status: 422 });
      await requestPasswordReset(ctx.app, v.data.email);
      ctx.redirect('/forgot-password?sent=1');
    },
    { rateLimit: 'passwordReset' },
  );

  r.get('/reset-password', async (ctx) => {
    const token = ctx.query.get('token') ?? '';
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new HttpError(400, 'This reset link is incomplete. Request a new one.');
    ctx.res.setHeader('Referrer-Policy', 'no-referrer');
    await render(ctx, { title: 'Choose a new password', noindex: true }, <ResetPage token={token} />);
  });
  r.post(
    '/reset-password',
    async (ctx) => {
      const v = parseWith(resetSchema, ctx.form);
      if (!v.ok) return render(ctx, { title: 'Choose a new password' }, <ResetPage token={ctx.form.token ?? ''} errors={v.errors} />, { status: 422 });
      try {
        await resetPassword(ctx.app, v.data.token, v.data.password);
      } catch (e) {
        if (e instanceof UserFacingError) {
          return render(ctx, { title: 'Choose a new password' }, <ResetPage token={v.data.token} errors={{ [e.code === 'password' ? 'password' : '_form']: e.message }} />, {
            status: 422,
          });
        }
        throw e;
      }
      ctx.setFlash('success', 'Password changed. Sign in with your new password.');
      ctx.redirect('/login');
    },
    { rateLimit: 'passwordReset' },
  );
}
