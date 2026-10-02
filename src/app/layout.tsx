import type { Metadata } from "next";
import { APP_NAME } from "@/lib/product-info";
import { OpenSourceButton } from "@/components/open-source-button";
import "./globals.css";

export const metadata: Metadata = {
  title: `${APP_NAME}: sitemap change monitoring`,
  description:
    "Track sitemap URLs and review additions, removals and reappearances.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <body className="min-h-dvh bg-cream-100 font-sans text-neutral-900" suppressHydrationWarning>
        <div className="isolate">
          {children}
          <OpenSourceButton />
        </div>
      </body>
    </html>
  );
}
