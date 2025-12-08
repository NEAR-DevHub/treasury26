import { PageComponentLayout } from "@/components/page-component-layout";

export default function AddressBookPage() {
  return (
    <PageComponentLayout title="Address Book" description="Manage your saved recipients">
      <div className="rounded-lg border bg-card p-6">
        <p className="text-muted-foreground">
          Store and manage frequently used wallet addresses.
        </p>
      </div>
    </PageComponentLayout>
  );
}
