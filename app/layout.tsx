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
            <Link className="brand" href="/">Air Freight <span>RFP Response</span></Link>
            <span className="masthead-label">Demo reviewer</span>
          </div>
        </header>
        <main className="container" id="main-content">{children}</main>
      </body>
    </html>
  );
}
