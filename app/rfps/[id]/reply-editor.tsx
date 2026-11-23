"use client";

import { useRef } from "react";

export function ReplyEditor({
  id, label, help, rows, maxLength, defaultValue, examples,
}: {
  id: string;
  label: string;
  help: string;
  rows: number;
  maxLength: number;
  defaultValue?: string;
  examples: { label: string; body: string }[];
}) {
  const input = useRef<HTMLTextAreaElement>(null);

  function loadExample(body: string) {
    if (!input.current) return;
    input.current.value = body;
    input.current.focus();
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <p className="muted" id={`${id}-help`}>{help}</p>
      <div className="reply-examples" role="group" aria-label="Examples to load into the editor">
        {examples.map((example) => (
          <button key={example.label} className="button" type="button" onClick={() => loadExample(example.body)}>
            {example.label}
          </button>
        ))}
      </div>
      <textarea ref={input} id={id} name="body" aria-describedby={`${id}-help`}
        rows={rows} maxLength={maxLength} defaultValue={defaultValue} required />
    </div>
  );
}
