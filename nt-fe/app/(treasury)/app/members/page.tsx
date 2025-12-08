import { PageComponentLayout } from "@/components/page-component-layout";

export default function MembersPage() {
  return (
    <PageComponentLayout title="Members" description="Manage team members and permissions">
      <div className="rounded-lg border bg-card p-6">
        <p className="text-muted-foreground">
          Manage treasury members and their permissions.
        </p>
      </div>
    </PageComponentLayout>
  );
}
