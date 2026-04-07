import type { HTMLAttributes } from "react";
import { forwardRef } from "react";

import { cn } from "../../lib/cn";

export type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant = "default", ...props },
  ref,
) {
  return (
    <span ref={ref} className={cn("ui-badge", `ui-badge--${variant}`, className)} {...props} />
  );
});

export { Badge };
