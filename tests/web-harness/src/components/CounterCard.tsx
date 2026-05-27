import { useState } from "react";
import { applyCounterAction } from "../lib/state";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui";

type CounterCardProps = {
  title: string;
};

export function CounterCard({ title }: CounterCardProps): JSX.Element {
  const [count, setCount] = useState(0);

  return (
    <Card as="section" className="counter-card" data-testid="counter-card">
      <CardHeader className="counter-card-header">
        <div>
          <p className="ui-eyebrow">Live State</p>
          <CardTitle data-testid="counter-title">{title}</CardTitle>
          <CardDescription>
            Small deterministic state changes for CT and E2E assertions.
          </CardDescription>
        </div>
        <Badge variant={count > 0 ? "default" : "outline"}>{count > 0 ? "active" : "idle"}</Badge>
      </CardHeader>
      <CardContent className="counter-card-content">
        <p aria-live="polite" className="counter-value" data-testid="counter-value">
          {count}
        </p>
        <div className="counter-actions">
          <Button
            data-testid="counter-inc"
            onClick={() => setCount((value) => applyCounterAction(value, "increment"))}
          >
            Increment
          </Button>
          <Button
            variant="secondary"
            data-testid="counter-dec"
            onClick={() => setCount((value) => applyCounterAction(value, "decrement"))}
          >
            Decrement
          </Button>
          <Button
            variant="ghost"
            data-testid="counter-reset"
            onClick={() => setCount((value) => applyCounterAction(value, "reset"))}
          >
            Reset
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
