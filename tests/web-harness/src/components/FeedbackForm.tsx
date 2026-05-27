import { type FormEvent, useState } from "react";
import { type ContactFieldErrors, validateContactFieldErrors } from "../lib/state";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui";

export function FeedbackForm(): JSX.Element {
  const successMessage = "Feedback submitted.";
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<string>("");
  const [fieldErrors, setFieldErrors] = useState<ContactFieldErrors>({});
  const isNameError = Boolean(fieldErrors.name);
  const isMessageError = Boolean(fieldErrors.message);
  const isError = result.length > 0 && result !== successMessage;

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const errors = validateContactFieldErrors(name, message);
    const firstError = errors.name ?? errors.message;
    if (firstError) {
      setFieldErrors(errors);
      setResult(firstError);
      return;
    }
    setFieldErrors({});
    setResult(successMessage);
  }

  return (
    <Card as="section" className="feedback-card">
      <CardHeader className="feedback-card-header">
        <div>
          <p className="ui-eyebrow">Signal Capture</p>
          <CardTitle>Feedback</CardTitle>
          <CardDescription>
            Submit deterministic validation states and a clean success path.
          </CardDescription>
        </div>
        <Badge variant={isError ? "outline" : "secondary"}>{isError ? "needs-fix" : "forms"}</Badge>
      </CardHeader>
      <CardContent>
        <form className="feedback-form" onSubmit={onSubmit} data-testid="feedback-form">
          <label htmlFor="feedback-name">Name</label>
          <input
            id="feedback-name"
            data-testid="feedback-name"
            aria-invalid={isNameError || undefined}
            aria-describedby={isNameError ? "feedback-result" : undefined}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />

          <label htmlFor="feedback-message">Message</label>
          <textarea
            id="feedback-message"
            data-testid="feedback-message"
            rows={4}
            aria-invalid={isMessageError || undefined}
            aria-describedby={isMessageError ? "feedback-result" : undefined}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />

          <div className="feedback-actions">
            <Button data-testid="feedback-submit" type="submit">
              Submit feedback
            </Button>
          </div>
        </form>
        {result ? (
          <p
            id="feedback-result"
            className={isError ? "alert" : "status-success"}
            role={isError ? "alert" : "status"}
            aria-live={isError ? "assertive" : "polite"}
            data-testid="feedback-result"
          >
            {result}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
