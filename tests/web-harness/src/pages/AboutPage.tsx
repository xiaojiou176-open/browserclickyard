import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui";

export function AboutPage(): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card as="section" data-testid="about-page">
      <CardHeader className="page-card-header">
        <div>
          <p className="ui-eyebrow">Harness Notes</p>
          <CardTitle>About This Demo</CardTitle>
          <CardDescription>
            Explain why the demo exists and what kinds of regression evidence it supports.
          </CardDescription>
        </div>
        <Badge variant="outline">docs</Badge>
      </CardHeader>
      <CardContent className="stack-sm">
        <Button
          variant="secondary"
          data-testid="about-toggle"
          aria-expanded={expanded}
          aria-controls="about-details"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Hide" : "Show"} details
        </Button>
        <p id="about-details" data-testid="about-details" hidden={!expanded}>
          This page provides deterministic interaction states for CT/E2E assertions.
        </p>
      </CardContent>
    </Card>
  );
}
