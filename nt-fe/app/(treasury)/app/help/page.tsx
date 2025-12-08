import { PageComponentLayout } from "@/components/page-component-layout";

export default function HelpPage() {
  return (
    <PageComponentLayout title="Help & Support">
      <div className="space-y-4">
        <div className="rounded-lg border bg-card p-6">
          <h3 className="text-lg font-semibold mb-2">Documentation</h3>
          <p className="text-muted-foreground">
            Access comprehensive guides and tutorials.
          </p>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <h3 className="text-lg font-semibold mb-2">Contact Support</h3>
          <p className="text-muted-foreground">
            Get help from our support team.
          </p>
        </div>
        <div className="rounded-lg border bg-card p-6">
          <h3 className="text-lg font-semibold mb-2">FAQs</h3>
          <p className="text-muted-foreground">
            Find answers to commonly asked questions.
          </p>
        </div>
      </div>
    </PageComponentLayout>
  );
}
