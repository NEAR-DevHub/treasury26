import { PageComponentLayout } from "@/components/page-component-layout";

export default function EarnPage() {
  return (
    <PageComponentLayout title="Earn" description="Earn rewards on your assets">
      <div className="rounded-lg border bg-card p-6">
        <p className="text-muted-foreground">
          Explore earning opportunities and staking rewards.
        </p>
      </div>
    </PageComponentLayout>
  );
}
