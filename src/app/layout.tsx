import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentPlane",
  description: "Claude Agent-as-a-Service",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
