"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/dashboard", label: "Websites" },
  { href: "/dashboard/settings", label: "Settings" },
] as const;

/** Pill count next to “Alerts” in main nav (desktop + mobile). */
export function UnreadAlertsNavBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  const text = count > 99 ? "99+" : String(count);
  return (
    <span
      className="inline-flex min-h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-500 px-1 text-[10px] font-semibold leading-none text-white tabular-nums"
      aria-hidden
    >
      {text}
    </span>
  );
}

export function TopNav({
  className = "",
}: {
  className?: string;
  unreadAlertCount?: number;
}) {
  const pathname = usePathname();
  return (
    <nav className={`flex items-center gap-1 ${className}`} aria-label="Main">
      {links.map(({ href, label }) => {
        const active =
          pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm transition ${
              active
                ? "bg-neutral-900 text-cream-100"
                : "text-neutral-700 hover:bg-white/70 hover:text-neutral-900"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
