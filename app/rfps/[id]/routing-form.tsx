"use client";

import { useActionState, type ReactNode } from "react";
import type { RoutingActionState } from "./routing-actions";

export function RoutingForm({
  action, children, button, pendingLabel = "Saving…", primary = false,
}: {
  action: (state: RoutingActionState, form: FormData) => Promise<RoutingActionState>;
  children?: ReactNode;
  button: string;
  pendingLabel?: string;
  primary?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, { error: null });
  return (
    <form action={formAction} className="routing-form">
      <fieldset className="field-stack" disabled={pending}>
        {children}
        <button className={primary ? "button primary" : "button"} type="submit">{pending ? pendingLabel : button}</button>
      </fieldset>
      {state.error && <p className="routing-error" role="alert">{state.error}</p>}
    </form>
  );
}
