const filledShadow = "shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]";

/* Colour treatments shared by every button in the app (see components/ui/button.tsx). */
export const buttonTones = {
  primary: `bg-ink text-canvas hover:opacity-90 dark:bg-ink dark:text-canvas ${filledShadow}`,
  secondary: "bg-surface text-ink shadow-btn hover:bg-inset aria-expanded:bg-hover",
  ghost: "bg-hover-2 text-ink hover:bg-line-strong",
  accent: `bg-accent text-white hover:bg-accent-ink ${filledShadow}`,
  success: `bg-green text-white hover:brightness-95 ${filledShadow}`,
  danger: `bg-red text-white hover:brightness-95 ${filledShadow}`,
  /* transparent until hovered — for dense toolbars/action rows */
  quiet: "text-ink hover:bg-hover",
} as const;
