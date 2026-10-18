import type { ReactNode } from 'react';
import { CsrfField } from './context.tsx';

export type Errors = Record<string, string | undefined>;
export type Values = Record<string, string | undefined | null>;

interface FieldBase {
  name: string;
  label: string;
  errors?: Errors;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
}

function describedBy(name: string, hint: unknown, error: unknown) {
  return [hint ? `${name}-hint` : null, error ? `${name}-error` : null].filter(Boolean).join(' ') || undefined;
}

function FieldShell({ name, label, errors, hint, required, className, children }: FieldBase & { children: ReactNode }) {
  const error = errors?.[name];
  return (
    <div className={`field ${className ?? ''}`}>
      <label className="label" htmlFor={`f-${name}`}>
        {label}
        {required ? null : <span className="font-normal text-[var(--color-muted)]"> (optional)</span>}
      </label>
      {children}
      {hint ? (
        <p className="hint" id={`${name}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="error-text" id={`${name}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextField(
  props: FieldBase & {
    value?: string | number | null;
    type?: string;
    autoComplete?: string;
    inputMode?: string;
    maxLength?: number;
    min?: string | number;
    max?: string | number;
    step?: string | number;
    pattern?: string;
    placeholder?: string;
  },
) {
  const { name, errors, hint, required, value, type = 'text', ...rest } = props;
  return (
    <FieldShell {...props}>
      <input
        className="input"
        id={`f-${name}`}
        name={name}
        type={type}
        defaultValue={value ?? ''}
        required={required}
        aria-invalid={errors?.[name] ? 'true' : undefined}
        aria-describedby={describedBy(name, hint, errors?.[name])}
        autoComplete={rest.autoComplete}
        inputMode={rest.inputMode}
        maxLength={rest.maxLength}
        min={rest.min}
        max={rest.max}
        step={rest.step}
        pattern={rest.pattern}
        placeholder={rest.placeholder}
      />
    </FieldShell>
  );
}

export function TextArea(props: FieldBase & { value?: string | null; rows?: number; maxLength?: number }) {
  const { name, errors, hint, required, value, rows = 4, maxLength } = props;
  return (
    <FieldShell {...props}>
      <textarea
        className="textarea"
        id={`f-${name}`}
        name={name}
        rows={rows}
        maxLength={maxLength}
        required={required}
        defaultValue={value ?? ''}
        aria-invalid={errors?.[name] ? 'true' : undefined}
        aria-describedby={describedBy(name, hint, errors?.[name])}
      />
    </FieldShell>
  );
}

export function SelectField(props: FieldBase & { value?: string | null; options: Array<{ value: string; label: string }>; placeholder?: string }) {
  const { name, errors, hint, required, value, options, placeholder } = props;
  return (
    <FieldShell {...props}>
      <select
        className="select"
        id={`f-${name}`}
        name={name}
        required={required}
        defaultValue={value ?? ''}
        aria-invalid={errors?.[name] ? 'true' : undefined}
        aria-describedby={describedBy(name, hint, errors?.[name])}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function Checkbox({ name, label, checked, errors, value = 'on' }: { name: string; label: ReactNode; checked?: boolean; errors?: Errors; value?: string }) {
  const error = errors?.[name];
  return (
    <div>
      <label className="check" htmlFor={`f-${name}`}>
        <input
          type="checkbox"
          id={`f-${name}`}
          name={name}
          value={value}
          defaultChecked={!!checked}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? `${name}-error` : undefined}
        />
        <span>{label}</span>
      </label>
      {error ? (
        <p className="error-text mt-1 pl-7" id={`${name}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A POST form with the CSRF token included. */
export function Form({
  action,
  children,
  className,
  multipart,
  id,
  ariaLabel,
}: {
  action: string;
  children: ReactNode;
  className?: string;
  multipart?: boolean;
  id?: string;
  ariaLabel?: string;
}) {
  return (
    <form method="post" action={action} className={className} encType={multipart ? 'multipart/form-data' : undefined} id={id} aria-label={ariaLabel} noValidate>
      <CsrfField />
      {children}
    </form>
  );
}

/** One-button POST form (remove, toggle, approve…). */
export function ActionButton({
  action,
  label,
  className = 'btn btn-quiet btn-sm',
  fields = {},
  confirm,
  ariaLabel,
}: {
  action: string;
  label: ReactNode;
  className?: string;
  fields?: Record<string, string>;
  confirm?: string;
  ariaLabel?: string;
}) {
  return (
    <form method="post" action={action} className="inline" data-confirm={confirm}>
      <CsrfField />
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" className={className} aria-label={ariaLabel}>
        {label}
      </button>
    </form>
  );
}

export function FormErrors({ errors }: { errors?: Errors }) {
  if (!errors) return null;
  const list = Object.entries(errors).filter(([, v]) => v);
  if (!list.length) return null;
  const general = errors._form;
  return (
    <div className="notice notice-error" role="alert" tabIndex={-1} id="form-errors">
      {general ? <p className="font-semibold">{general}</p> : <p className="font-semibold">Check the highlighted fields.</p>}
      {list.length > (general ? 1 : 0) ? (
        <ul className="mt-1 list-disc pl-5 text-sm">
          {list
            .filter(([k]) => k !== '_form')
            .map(([k, v]) => (
              <li key={k}>
                <a href={`#f-${k}`} className="underline">
                  {v}
                </a>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}
