"use client";

import { PageCard } from "@/components/card";
import { LegalPageLayout } from "@/components/legal-page-layout";

export default function TermsPage() {
  return (
    <LegalPageLayout title="Terms of Service">
      <PageCard className="max-w-4xl mx-auto">
        <article className="space-y-8">
          <div>
            <h1 className="text-2xl font-semibold">Terms of Service</h1>
            <p className="text-muted-foreground mt-2">
              Last updated: February 1, 2026
            </p>
          </div>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">1. Acceptance of Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              By accessing or using Trezu, you agree to be bound by these Terms
              of Service. If you do not agree to these terms, please do not use
              our service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">2. Description of Service</h2>
            <p className="text-muted-foreground leading-relaxed">
              Trezu provides a platform for managing treasury operations on the
              NEAR blockchain. Our service includes wallet management, payment
              processing, and treasury analytics.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">3. User Responsibilities</h2>
            <p className="text-muted-foreground leading-relaxed">
              Users are responsible for maintaining the security of their
              accounts and wallets. You agree to notify us immediately of any
              unauthorized access or security breach.
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
              <li>Maintain accurate account information</li>
              <li>Keep your credentials secure</li>
              <li>Comply with applicable laws and regulations</li>
              <li>Use the service in good faith</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">4. Prohibited Activities</h2>
            <p className="text-muted-foreground leading-relaxed">
              You agree not to:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
              <li>Use the service for illegal purposes</li>
              <li>Attempt to gain unauthorized access to the platform</li>
              <li>Interfere with the proper operation of the service</li>
              <li>Transmit harmful code or malware</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">5. Intellectual Property</h2>
            <p className="text-muted-foreground leading-relaxed">
              All content, features, and functionality of Trezu are owned by us
              and are protected by international copyright, trademark, and other
              intellectual property laws.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">6. Limitation of Liability</h2>
            <p className="text-muted-foreground leading-relaxed">
              Trezu is provided on an &quot;as is&quot; and &quot;as
              available&quot; basis. We make no warranties regarding the
              reliability, availability, or accuracy of the service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">7. Changes to Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              We reserve the right to modify these terms at any time. We will
              notify users of significant changes through the platform or via
              email.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">8. Contact Information</h2>
            <p className="text-muted-foreground leading-relaxed">
              For questions about these Terms of Service, please contact us
              through our support channels.
            </p>
          </section>
        </article>
      </PageCard>
    </LegalPageLayout>
  );
}
