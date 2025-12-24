"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useNear } from "@/stores/near-store";
import { useUserTreasuries } from "@/hooks/use-treasury-queries";
import { Button } from "@/components/button";
import { GradFlow } from 'gradflow'
import Image from "next/image";
import Link from "next/link";

function GradientTitle() {
  return (
    <p
      className="text-[30px] lg:text-5xl tracking-[-1%] leading-[28px] lg:leading-[48px] text-center lg:text-left w-full h-fit font-medium text-white backdrop-blur-[10px] mix-blend-overlay"
      style={{
        WebkitMask: 'linear-gradient(#000 0 0) text',
        mask: 'linear-gradient(#000 0 0) text',
      }}
    >
      Cross-chain multisig security for managing digital assets
    </p>);
}

export default function AppRedirect() {
  const router = useRouter();
  const { accountId, connect } = useNear();
  const { data: treasuries = [], isLoading } = useUserTreasuries(accountId);

  useEffect(() => {
    if (!isLoading && treasuries.length > 0) {
      router.push(`/${treasuries[0].daoId}`);
    }
  }, [treasuries, isLoading, router]);

  return (
    <div className="relative h-screen w-screen">
      <GradFlow config={{
        color1: { r: 102, g: 237, b: 255 },
        color2: { r: 0, g: 0, b: 0 },
        color3: { r: 0, g: 255, b: 110 },
        speed: 0.6,
        scale: 2,
        type: 'animated',
        noise: 0.18
      }} className="absolute" />
      <div className="flex relative w-full h-screen items-center justify-between">

        <div className="w-full lg:w-2/5 h-full p-2 lg:p-4 flex flex-col justify-center ">
          <div className="w-full min-h-[30%] flex items-center  lg:hidden">
            <GradientTitle />
          </div>
          <div className="w-full gap-12 flex flex-col p-4 items-center h-full justify-center bg-white rounded-2xl lg:max-w-4xl">
            <Image src='/logo.svg' alt="logo" width={0} height={0} className="w-[200px] h-auto" />
            <div className="flex w-full flex-col items-center justify-center gap-6 ">
              <div className="flex w-full flex-col gap-2 text-center">
                <h1 className="text-2xl font-semibold">
                  Welcome to your Treasury
                </h1>
                <p className="text-sm text-muted-foreground font-medium">
                  Using your wallet works like signing in to Treasury..
                </p>
              </div>
              <div className="flex flex-col w-full px-4 lg:px-16 px gap-3">
                <Button className="w-full" onClick={connect}>
                  Connect Wallet
                </Button>
                <p className="text-center text-sm">
                  Don't have a wallet? <Link href="https://wallet.near.org" className="hover:underline" target="_blank">Create one</Link>
                </p>
              </div>
            </div>
          </div>

        </div>
        <div className="hidden lg:flex w-3/5 h-full py-12 pl-16 flex-col gap-9">
          <div className="w-full pr-16">
            <GradientTitle />
          </div>
          <div className="h-full w-fit rounded-4xl backdrop-blur-[104px] overflow-clip max-w-full rounded-r-none">
            <Image src='/welcome.svg' loading="eager" alt="welcome" width={0} height={0} className="h-[120%] w-auto max-w-none" />
          </div>
        </div>
      </div>
    </div>
  )
}
