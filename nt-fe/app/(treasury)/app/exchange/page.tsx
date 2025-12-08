import { PageComponentLayout } from "@/components/page-component-layout";

export default function ExchangePage() {
  return (
    <PageComponentLayout title="Exchange" description="Exchange your tokens securely and efficiently">
      <div className="rounded-lg border bg-card p-6">
        <p className="text-muted-foreground">
          Exchange tokens and manage conversions.
        </p>
      </div>
    </PageComponentLayout>
  );
}
