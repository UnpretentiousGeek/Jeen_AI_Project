"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown, PanelLeftClose, PanelLeftOpen, Search, X } from "lucide-react";
import GlideMenu from "@/components/primitives/GlideMenu";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────
 * SIDEBAR NAV (adapted from beautifului.dev)
 * Brand row with a collapse control, primary navigation with
 * gliding hover, and a searchable list of items. Collapsing
 * keeps icons aligned in a narrow rail; the list hides.
 * ───────────────────────────────────────────────────────── */

export type SidebarNavItem = {
  key: string;
  label: string;
  icon: ReactNode;
  count?: number;
  active?: boolean;
  /** Renders as a link (client-side navigation) when set. */
  href?: string;
  onClick?: () => void;
  ariaLabel?: string;
};

export type SidebarListItem = {
  id: string;
  label: string;
  /** Short status line under the label. */
  meta?: ReactNode;
  active?: boolean;
  /** Right-aligned content that is always visible (e.g. a progress indicator). */
  trailing?: ReactNode;
  /** Right-aligned actions revealed on hover or focus. */
  actions?: ReactNode;
};

const MOTION = {
  expandedWidth: 248,
  collapsedWidth: 56,
  duration: 280,
  copyDuration: 180,
  copyOffset: 8,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
};

const SEARCH_MOTION = { duration: 180, closedWidth: 32, easing: "cubic-bezier(0.16, 1, 0.3, 1)" };

const COLLAPSED_KEY = "sidebar-nav-collapsed";

function GlideGroup({ children }: { children: ReactNode }) {
  return (
    <GlideMenu rowSelector="[data-row]" highlightClassName="rounded-[8px] bg-hover-2" className="group/glide flex flex-col gap-px">
      {children}
    </GlideMenu>
  );
}

function RailButton({ item }: { item: SidebarNavItem }) {
  const className = cn(
    "sidebar-row relative z-10 mx-2 flex h-8 items-center rounded-[8px] px-2 text-left outline-none transition-[width,background-color,color,transform] duration-150 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring/40",
    item.active && "bg-hover-2 group-hover/glide:bg-transparent",
  );
  const content = (
    <>
      <span className={cn("flex size-5 shrink-0 items-center justify-center [&_svg]:size-[18px]", item.active ? "text-ink" : "text-ink-2")}>{item.icon}</span>
      <span className={cn("sidebar-copy ml-2 min-w-0 flex-1 truncate text-[14px] font-medium", item.active ? "text-ink" : "text-ink-2")}>{item.label}</span>
      {item.count !== undefined && (
        <span className="sidebar-copy mr-1 shrink-0 text-[12px] font-medium tabular-nums text-ink-3">{item.count}</span>
      )}
    </>
  );
  const shared = {
    "data-row": true,
    title: item.label,
    "aria-label": item.ariaLabel,
    "aria-current": item.active ? ("page" as const) : undefined,
    className,
  };
  return item.href
    ? <Link href={item.href} onClick={item.onClick} {...shared}>{content}</Link>
    : <button type="button" onClick={item.onClick} {...shared}>{content}</button>;
}

export default function SidebarNav({
  brand,
  primaryAction,
  items,
  listTitle,
  listItems,
  onPick,
  query,
  onQueryChange,
  searchLabel,
  emptyMessage = "Nothing Found",
}: {
  brand: { name: string; icon: ReactNode };
  primaryAction: SidebarNavItem;
  items: SidebarNavItem[];
  listTitle: string;
  listItems: SidebarListItem[];
  onPick: (id: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  searchLabel: string;
  emptyMessage?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSED_KEY) === "true");
    } catch {
      // Storage can be unavailable (private mode, blocked site data); default to expanded.
    }
  }, []);

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const setCollapsedAndRemember = (next: boolean) => {
    setCollapsed(next);
    if (next) {
      setSearchOpen(false);
      onQueryChange("");
    }
    try {
      window.localStorage.setItem(COLLAPSED_KEY, String(next));
    } catch {
      // Collapsing still works for this visit without storage.
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    onQueryChange("");
    searchButtonRef.current?.focus();
  };

  return (
    <aside
      data-sidebar-collapsed={collapsed}
      aria-label="Workspace navigation"
      className="sticky top-0 hidden h-screen shrink-0 overflow-hidden border-r border-line bg-canvas py-3 transition-[width] lg:flex"
      style={{
        width: collapsed ? MOTION.collapsedWidth : MOTION.expandedWidth,
        transitionDuration: `${MOTION.duration}ms`,
        transitionTimingFunction: MOTION.easing,
        "--sidebar-copy-duration": `${MOTION.copyDuration}ms`,
        "--sidebar-copy-offset": `${MOTION.copyOffset}px`,
        "--sidebar-easing": MOTION.easing,
      } as CSSProperties}
    >
      <div className="flex min-h-0 shrink-0 flex-col" style={{ width: MOTION.expandedWidth }}>
        <div className="relative mb-3 h-10 shrink-0">
          <span className="sidebar-logo absolute left-2 top-1 flex h-8 items-center px-2">
            <span className="flex size-5 shrink-0 items-center justify-center text-ink [&_svg]:size-[18px]">{brand.icon}</span>
            <span className="sidebar-copy ml-2 truncate text-[14px] font-semibold text-ink">{brand.name}</span>
          </span>
          <button
            type="button"
            aria-label="Collapse sidebar"
            aria-hidden={collapsed}
            tabIndex={collapsed ? -1 : 0}
            onClick={() => setCollapsedAndRemember(true)}
            className="sidebar-collapse-control absolute right-2 top-1 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <PanelLeftClose className="size-[18px]" />
          </button>
          <button
            type="button"
            aria-label="Expand sidebar"
            aria-hidden={!collapsed}
            tabIndex={collapsed ? 0 : -1}
            onClick={() => setCollapsedAndRemember(false)}
            className="sidebar-expand-control absolute left-2 top-1 flex size-9 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color] duration-150 hover:bg-hover-2 hover:text-ink"
          >
            <PanelLeftOpen className="size-[18px]" />
          </button>
        </div>

        <nav aria-label="Primary">
          <GlideGroup>
            <RailButton item={primaryAction} />
            {items.map((item) => <RailButton key={item.key} item={item} />)}
          </GlideGroup>
        </nav>

        <div className="sidebar-copy dashboard-scrollbar mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain" inert={collapsed}>
          <div className="relative mx-2 mb-1 h-8">
            <div
              aria-hidden={searchOpen}
              className={cn("absolute inset-0 flex items-center gap-1.5 px-2 text-[12.5px] font-medium text-ink-3 transition-[opacity,transform]", searchOpen ? "pointer-events-none -translate-x-1 opacity-0" : "translate-x-0 opacity-100")}
              style={{ transitionDuration: `${SEARCH_MOTION.duration}ms`, transitionTimingFunction: SEARCH_MOTION.easing }}
            >
              <ChevronDown className="size-4" aria-hidden="true" />
              <h2>{listTitle}</h2>
            </div>
            <button
              ref={searchButtonRef}
              type="button"
              aria-label={searchLabel}
              aria-expanded={searchOpen}
              onClick={() => setSearchOpen(true)}
              className={cn("absolute right-0 top-0 z-10 flex size-8 items-center justify-center rounded-[8px] text-ink-3 transition-[opacity,background-color,color,transform] hover:bg-hover-2 hover:text-ink active:scale-[0.96]", searchOpen ? "pointer-events-none opacity-0" : "opacity-100")}
              style={{ transitionDuration: `${SEARCH_MOTION.duration}ms` }}
            >
              <Search className="size-4" />
            </button>
            <div
              className={cn("absolute right-0 top-0 z-20 flex h-8 items-center overflow-hidden rounded-[8px] bg-field text-ink-3 shadow-hairline transition-[width,opacity] focus-within:text-ink-2", searchOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0")}
              style={{ width: searchOpen ? "100%" : SEARCH_MOTION.closedWidth, transitionDuration: `${SEARCH_MOTION.duration}ms`, transitionTimingFunction: SEARCH_MOTION.easing }}
            >
              <Search className="ml-2 size-[15px] shrink-0" aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                tabIndex={searchOpen ? 0 : -1}
                onChange={(event) => onQueryChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeSearch();
                  }
                }}
                placeholder={searchLabel}
                aria-label={searchLabel}
                className="ml-1.5 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-3"
              />
              <button
                type="button"
                aria-label="Close search"
                tabIndex={searchOpen ? 0 : -1}
                onClick={closeSearch}
                className="flex size-8 shrink-0 items-center justify-center rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96]"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          <GlideGroup>
            {listItems.map((item) => (
              <div
                key={item.id}
                data-row
                className={cn("group/item relative z-10 mx-2 flex items-center rounded-[8px] transition-colors", item.active && "bg-hover-2 group-hover/glide:bg-transparent")}
              >
                <button
                  type="button"
                  title={item.label}
                  aria-current={item.active ? "page" : undefined}
                  onClick={() => onPick(item.id)}
                  className="flex min-w-0 flex-1 flex-col rounded-[8px] px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <span className={cn("truncate text-[13.5px] font-medium", item.active ? "text-ink" : "text-ink-2")}>{item.label}</span>
                  {item.meta && <span className="truncate text-[11.5px] text-ink-3">{item.meta}</span>}
                </button>
                {/* Right inset matches the label's left padding (8px); icon buttons pull back their own padding. */}
                {(item.trailing || item.actions) && (
                  <span className="mr-2 flex shrink-0 items-center">
                    {item.trailing}
                    {item.actions && (
                      <span className="-mr-1.5 flex items-center transition-opacity duration-150 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/item:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
                        {item.actions}
                      </span>
                    )}
                  </span>
                )}
              </div>
            ))}
            {listItems.length === 0 && <p className="mx-2 px-2 py-2 text-[12.5px] text-ink-3">{emptyMessage}</p>}
          </GlideGroup>
        </div>
      </div>
    </aside>
  );
}
