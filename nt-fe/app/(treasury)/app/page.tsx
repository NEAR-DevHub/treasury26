"use client";

import { PageComponentLayout } from "@/components/page-component-layout";
import { AssetsTable } from "@/components/assets-table";
import { useTreasury } from "@/stores/treasury-store";

export default function AppPage() {
  const { selectedTreasury } = useTreasury();

  return (
    <PageComponentLayout
      title="Dashboard"
      description="Overview of your treasury assets and activity"
    >
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 mb-6">
        <div className="rounded-lg border bg-card p-6">
          <h3 className="text-sm font-medium text-muted-foreground">Total Balance</h3>
          <p className="text-2xl font-bold mt-2">$0.00</p>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <h3 className="text-sm font-medium text-muted-foreground">Pending Requests</h3>
          <p className="text-2xl font-bold mt-2">0</p>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <h3 className="text-sm font-medium text-muted-foreground">Active Members</h3>
          <p className="text-2xl font-bold mt-2">0</p>
        </div>
      </div>

      <AssetsTable />
    </PageComponentLayout>
  );
}
