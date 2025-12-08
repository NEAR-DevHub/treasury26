import { PageComponentLayout } from "@/components/page-component-layout";

export default function PaymentsPage() {
  return (
    <PageComponentLayout title="Payments" description="Send and receive funds securely">
      <div className="rounded-lg border bg-card p-6">
        <p className="text-muted-foreground">
          View and manage payment transactions.
        </p>
      </div>
    </PageComponentLayout>
  );
}
