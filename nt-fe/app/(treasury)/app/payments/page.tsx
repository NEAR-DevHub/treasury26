"use client";

import { PageCard } from "@/components/card";
import { TokenInput } from "@/components/large-inputs";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useState } from "react";

export default function PaymentsPage() {
  const [amount, setAmount] = useState(0);
  const [token, setToken] = useState("NEAR");

  return (
    <PageComponentLayout title="Payments" description="Send and receive funds securely">
      <PageCard>
        <TokenInput
          amount={amount}
          token={token}
          setAmount={setAmount}
          setToken={setToken}
        />
      </PageCard>
    </PageComponentLayout>
  );
}
