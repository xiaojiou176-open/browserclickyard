import type { HTMLAttributes } from "react";
import { forwardRef, type Ref } from "react";

import { cn } from "../../lib/cn";

type CardTag = "section" | "article" | "div";
export type CardProps = HTMLAttributes<HTMLElement> & {
  as?: CardTag;
};
export type CardHeaderProps = HTMLAttributes<HTMLDivElement>;
type CardTitleTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
export type CardTitleProps = HTMLAttributes<HTMLHeadingElement> & {
  as?: CardTitleTag;
};
export type CardContentProps = HTMLAttributes<HTMLDivElement>;
export type CardFooterProps = HTMLAttributes<HTMLDivElement>;

const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { as: Component = "section", className, ...props },
  ref,
) {
  if (Component === "article") {
    return (
      <article ref={ref as Ref<HTMLElement>} className={cn("ui-card", className)} {...props} />
    );
  }
  if (Component === "div") {
    return <div ref={ref as Ref<HTMLDivElement>} className={cn("ui-card", className)} {...props} />;
  }
  return <section ref={ref as Ref<HTMLElement>} className={cn("ui-card", className)} {...props} />;
});

const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(function CardHeader(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn("ui-card-header", className)} {...props} />;
});

const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(function CardTitle(
  { as: Component = "h3", className, ...props },
  ref,
) {
  return <Component ref={ref} className={cn("ui-card-title", className)} {...props} />;
});

const CardContent = forwardRef<HTMLDivElement, CardContentProps>(function CardContent(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn("ui-card-content", className)} {...props} />;
});

const CardFooter = forwardRef<HTMLDivElement, CardFooterProps>(function CardFooter(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn("ui-card-footer", className)} {...props} />;
});

export { Card, CardContent, CardFooter, CardHeader, CardTitle };
