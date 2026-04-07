export type CounterAction = "increment" | "decrement" | "reset";
export type ContactFieldErrors = {
  name?: string;
  message?: string;
};

export function applyCounterAction(current: number, action: CounterAction): number {
  if (action === "increment") {
    return current + 1;
  }
  if (action === "decrement") {
    return Math.max(0, current - 1);
  }
  return 0;
}

export function validateContactFieldErrors(name: string, message: string): ContactFieldErrors {
  const errors: ContactFieldErrors = {};
  if (name.trim().length < 2) {
    errors.name = "Name must contain at least 2 characters.";
  }
  if (message.trim().length < 8) {
    errors.message = "Message must contain at least 8 characters.";
  }
  return errors;
}

export function validateContactMessage(name: string, message: string): string | null {
  const errors = validateContactFieldErrors(name, message);
  if (errors.name) {
    return errors.name;
  }
  if (errors.message) {
    return errors.message;
  }
  return null;
}
