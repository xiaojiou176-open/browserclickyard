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

export function SafePage(): JSX.Element {
  const [enabled, setEnabled] = useState(false);
  return (
    <Card as="section" data-testid="safe-page">
      <CardHeader className="page-card-header">
        <div>
          <p className="ui-eyebrow">Guardrails</p>
          <CardTitle>Safe Actions</CardTitle>
          <CardDescription>
            Keep one explicit state toggle without destructive side effects.
          </CardDescription>
        </div>
        <Badge variant={enabled ? "default" : "secondary"}>{enabled ? "enabled" : "idle"}</Badge>
      </CardHeader>
      <CardContent className="stack-sm">
        <p>This page intentionally excludes destructive controls.</p>
        <Button
          variant="secondary"
          data-testid="safe-toggle"
          aria-pressed={enabled}
          onClick={() => setEnabled((value) => !value)}
        >
          {enabled ? "Disable" : "Enable"} safe mode
        </Button>
        <p data-testid="safe-state">safe_mode={enabled ? "on" : "off"}</p>
      </CardContent>
    </Card>
  );
}
