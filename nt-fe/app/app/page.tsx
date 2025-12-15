"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useNear } from "@/stores/near-store";
import { useUserTreasuries } from "@/hooks/use-treasury-queries";
import { Button } from "@/components/ui/button";
import Image from "next/image";
import Link from "next/link";

export default function AppRedirect() {
  const router = useRouter();
  const { accountId, connect } = useNear();
  const { data: treasuries = [], isLoading } = useUserTreasuries(accountId);

  useEffect(() => {
    if (!isLoading && treasuries.length > 0) {
      router.push(`/${treasuries[0].daoId}`);
    }
  }, [treasuries, isLoading, router]);

  return <div className="flex w-full h-screen items-center gap-0 p-4 justify-between">
    <div className="w-2/5 gap-6 flex flex-col px-[76px] max-w-xl">
      <Image src='/logo.svg' alt="logo" width={200} height={48} />
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">
          Access your wallet to manage<br /> your treasuries
        </h1>
        <p className="text-sm text-muted-foreground">
          Using your wallet works like signing in to Treasury.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Button className="w-full" onClick={connect}>
          Connect Wallet
        </Button>
        <p className="text-center">
          Don't have a wallet? <Link href="https://wallet.near.org" className="hover:underline" target="_blank">Create one</Link>
        </p>
      </div>
    </div>
    <Image src='/welcome.svg' alt="welcome" width={0} height={0} className="h-full w-auto rounded-3xl" />
  </div>
}
