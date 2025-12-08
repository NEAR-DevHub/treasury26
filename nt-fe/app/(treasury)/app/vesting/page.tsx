import { PageComponentLayout } from "@/components/page-component-layout";

export default function VestingPage() {
  return (
    <PageComponentLayout title="Vesting" description="Create vesting schedules quickly and effortlessly">
      <div className="rounded-lg border bg-card p-6">
        <p className="text-muted-foreground">
          Manage vesting schedules and token releases.
        </p>
      </div>
    </PageComponentLayout>
  );
}
