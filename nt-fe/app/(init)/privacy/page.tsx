"use client";

import { PageCard } from "@/components/card";
import { LegalPageLayout } from "@/components/legal-page-layout";

export default function PrivacyPage() {
  return (
    <LegalPageLayout title="Privacy Policy">
      <PageCard className="max-w-4xl mx-auto">
        <article className="space-y-8">
          <div>
            <h1 className="text-2xl font-semibold">Privacy Policy</h1>
            <p className="text-muted-foreground mt-2">
              Last updated: February 1, 2026
            </p>
          </div>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">1. Introduction</h2>
            <p className="text-muted-foreground leading-relaxed">
              This Privacy Policy describes how Trezu collects, uses, and
              protects your personal information when you use our service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">2. Information We Collect</h2>
            <p className="text-muted-foreground leading-relaxed">
              We may collect the following types of information:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
              <li>
                <span className="font-medium text-foreground">
                  Wallet Information:
                </span>{" "}
                Your NEAR wallet address and related blockchain data
              </li>
              <li>
                <span className="font-medium text-foreground">Usage Data:</span>{" "}
                Information about how you interact with our platform
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Device Information:
                </span>{" "}
                Browser type, operating system, and device identifiers
              </li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">
              3. How We Use Your Information
            </h2>
            <p className="text-muted-foreground leading-relaxed">
              We use collected information to:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
              <li>Provide and maintain our service</li>
              <li>Process transactions and manage your treasury</li>
              <li>Improve and personalize user experience</li>
              <li>Communicate important updates and changes</li>
              <li>Detect and prevent fraud or abuse</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">4. Data Security</h2>
            <p className="text-muted-foreground leading-relaxed">
              We implement appropriate security measures to protect your personal
              information. However, no method of transmission over the internet
              is completely secure, and we cannot guarantee absolute security.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">5. Third-Party Services</h2>
            <p className="text-muted-foreground leading-relaxed">
              Our service may contain links to third-party websites or integrate
              with external services. We are not responsible for the privacy
              practices of these third parties.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">6. Data Retention</h2>
            <p className="text-muted-foreground leading-relaxed">
              We retain your personal information for as long as necessary to
              provide our services and comply with legal obligations. You may
              request deletion of your data at any time.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">7. Your Rights</h2>
            <p className="text-muted-foreground leading-relaxed">
              You have the right to:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-2">
              <li>Access your personal data</li>
              <li>Request correction of inaccurate data</li>
              <li>Request deletion of your data</li>
              <li>Object to processing of your data</li>
              <li>Data portability</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">8. Changes to This Policy</h2>
            <p className="text-muted-foreground leading-relaxed">
              We may update this Privacy Policy from time to time. We will notify
              you of any changes by posting the new policy on this page and
              updating the &quot;Last updated&quot; date.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">9. Contact Us</h2>
            <p className="text-muted-foreground leading-relaxed">
              If you have questions about this Privacy Policy, please contact us
              through our support channels.
            </p>
          </section>
        </article>
      </PageCard>
    </LegalPageLayout>
  );
}
