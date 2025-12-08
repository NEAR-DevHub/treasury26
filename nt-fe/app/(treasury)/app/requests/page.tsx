import { PageComponentLayout } from "@/components/page-component-layout";

export default function RequestsPage() {
  return (
    <PageComponentLayout title="Requests" description="View and manage all pending multisig requests">
      <div className="rounded-lg border bg-card p-6">
        <p className="text-muted-foreground">
          Manage and review treasury requests here.
        </p>
      </div>
    </PageComponentLayout>
  );
}
