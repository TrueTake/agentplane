import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Check whether a model supports the Claude Agent SDK runner. */
export function supportsClaudeRunner(model: string): boolean {
  return !model.includes("/") || model.startsWith("anthropic/");
}
