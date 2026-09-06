"use client";

import Link from "next/link";
import type { ComponentProps } from "react";

/** Keep native Next navigation/accessibility, but don't fetch every menu
 * destination merely because the sidebar is visible (or a link is hovered).
 * Clicked routes can still reuse Next's short-lived, in-tab Router Cache.
 */
export function NavigationLink(props: Omit<ComponentProps<typeof Link>, "prefetch">) {
  return <Link {...props} prefetch={false} />;
}
