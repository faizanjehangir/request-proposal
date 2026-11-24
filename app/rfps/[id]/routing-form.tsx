"use client";

import { useActionState, type ReactNode } from "react";
import type { RoutingActionState } from "./routing-actions";

export function RoutingForm({
  action, children, button, pendingLabel = "Saving…", primary = false, buttonFirst = false,
}: {
  action: (state: RoutingActionState, form: FormData) => Promise<RoutingActionState>;
  children?: ReactNode;
  button: string;
  pendingLabel?: string;
  primary?: boolean;
  buttonFirst?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  const submit = <button className={primary ? "button primary" : "button"} type="submit">{pending ? pendingLabel : button}</button>;
  return (
    <form action={formAction} className="routing-form">
      <fieldset className="field-stack" disabled={pending}>
        {buttonFirst && submit}
        {children}
        {!buttonFirst && submit}
      </fieldset>
      {state.error && <p className="routing-error" role="alert">{state.error}</p>}
    </form>
  );
}
