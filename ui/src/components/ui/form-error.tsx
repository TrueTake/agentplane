export function FormError({ error }: { error?: string | null | undefined }) {
  if (!error) return null;
  return <p className="text-xs text-destructive">{error}</p>;
}
