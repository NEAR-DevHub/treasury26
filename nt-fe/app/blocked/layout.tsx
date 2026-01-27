import type { Metadata } from "next";
import "../globals.css";

export const metadata: Metadata = {
  title: "Access Restricted | NEAR Treasury",
  description: "This service is not available in your region.",
  robots: "noindex, nofollow",
};

export default function BlockedLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
