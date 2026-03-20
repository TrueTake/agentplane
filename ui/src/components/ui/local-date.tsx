"use client";

export function LocalDate({ value, fallback = "\u2014" }: { value: string | null; fallback?: string }) {
  if (!value) return <>{fallback}</>;
  return <>{new Date(value).toLocaleString()}</>;
}
