import { createRef } from "react";
import Link from "next/link";
import { describe, expect, it, vi } from "vitest";
import { NavigationLink } from "./navigation-link";

describe("shell navigation requests", () => {
  it("disables speculative prefetch while retaining Next client navigation", () => {
    const element = NavigationLink({ href: "/inbox", children: "Inbox" });
    expect(element.type).toBe(Link);
    expect(element.props.prefetch).toBe(false);
    expect(element.props.href).toBe("/inbox");
  });

  it("preserves query strings, accessibility, event handlers and refs", () => {
    const ref = createRef<HTMLAnchorElement>();
    const onClick = vi.fn();
    const props = {
      href: "/settings?tab=whatsapp",
      "aria-label": "WhatsApp settings",
      className: "existing-style",
      children: "Settings",
      target: "_blank",
      onClick,
      ref,
    };
    expect(NavigationLink(props).props).toEqual({ ...props, prefetch: false });
    expect(onClick).not.toHaveBeenCalled();
  });
});
