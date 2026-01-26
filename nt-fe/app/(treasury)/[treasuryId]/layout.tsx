import { notFound } from "next/navigation";
import { getTreasuryConfig } from "@/lib/api";
import { TreasuryLayoutClient } from "./treasury-layout-client";

export default async function TreasuryLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ treasuryId: string }>;
}) {
  const { treasuryId } = await params;

  const config = await getTreasuryConfig(treasuryId);
  if (!config) {
    notFound();
  }

  return (
    <TreasuryLayoutClient treasuryId={treasuryId}>
      {children}
    </TreasuryLayoutClient>
  );
}
