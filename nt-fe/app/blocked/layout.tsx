import type { Metadata } from "next";
import "../globals.css";

export const metadata: Metadata = {
  title: "Service Not Available | NEAR Treasury",
  description: "Due to restrictions, this service is currently unavailable in your region.",
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
