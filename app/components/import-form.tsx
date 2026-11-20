"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { ImportIssue } from "@/src/db/schema";
import { IssueList } from "./import-feedback";

export default function ImportForm() {
  const router = useRouter();
  const [pending, setPending] = useState<"sample" | "upload" | null>(null);
  const [error, setError] = useState<{ message: string; issues?: ImportIssue[] } | null>(null);

  async function submit(mode: "sample" | "upload", payload: FormData) {
    setPending(mode);
    setError(null);
    payload.set("mode", mode);

    try {
      const response = await fetch("/api/imports", { method: "POST", body: payload });
      const result = await response.json();
      if (!response.ok) {
        setError(result);
        router.refresh();
        setPending(null);
        return;
      }
      router.push(`/rfps/${result.id}`);
    } catch {
      setError({ message: "The app could not complete the upload. Try again." });
      setPending(null);
    }
  }

  function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pending) void submit("upload", new FormData(event.currentTarget));
  }

  return (
    <>
      <section className="panel" aria-labelledby="upload-title">
        <div className="section-heading">
          <h2 id="upload-title">Import a workbook</h2>
          <p>Add an Excel file with the Shipper RFP and Transit Table sheets.</p>
        </div>
        <form onSubmit={upload}>
          <fieldset className="field-stack" disabled={pending !== null}>
            <div className="field">
              <label htmlFor="workbook">RFP workbook</label>
              <input id="workbook" name="workbook" type="file" accept=".xlsx" aria-describedby="workbook-limit" required />
              <small id="workbook-limit">.xlsx up to 5 MB</small>
            </div>
            <div className="field">
              <label htmlFor="email">Shipper email <span>Optional</span></label>
              <input id="email" name="email" type="file" accept=".txt,text/plain" aria-describedby="email-limit" />
              <small id="email-limit">UTF-8 .txt up to 256 KB</small>
            </div>
            <button className="button primary" type="submit">{pending === "upload" ? "Importing workbook…" : "Import workbook"}</button>
          </fieldset>
        </form>
        <div className="sample">
          <div><h3>Try the sample</h3><p>100 shipper lanes and 100 directed flight records.</p></div>
          <button className="button" type="button" disabled={pending !== null} onClick={() => submit("sample", new FormData())}>
            {pending === "sample" ? "Loading sample…" : "Load sample RFP"}
          </button>
        </div>
      </section>
      {error && (
        <section className="panel error-panel" role="alert" aria-labelledby="error-title">
          <h2 id="error-title">{error.message}</h2>
          {error.issues?.length ? <IssueList issues={error.issues} /> : null}
        </section>
      )}
    </>
  );
}
