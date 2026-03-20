import { Card, CardHeader, CardTitle, CardContent } from "./card";

interface MetricCardProps {
  label: string;
  children: React.ReactNode;
  className?: string;
}

export function MetricCard({ label, children, className }: MetricCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{children}</div>
      </CardContent>
    </Card>
  );
}
