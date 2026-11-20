import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "RFP intake · Air Freight", template: "%s · Air Freight" },
  description: "Air freight request intake for the RFP Response Team.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <header className="masthead">
          <div className="container masthead-content">
            <Link className="brand" href="/">
              <span className="brand-mark" aria-hidden="true">↗</span>
              <span className="brand-name">Air Freight <small>RFP Workspace</small></span>
            </Link>
            <span className="masthead-label">Simulation workspace</span>
          </div>
        </header>
        <main className="container" id="main-content">{children}</main>
      </body>
    </html>
  );
}
