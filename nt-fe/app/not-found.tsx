import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

export default function NotFound() {
  return (
    <div className="relative flex min-h-screen h-full flex-col items-center justify-center bg-black overflow-hidden">
      <Image
        src="/404.svg"
        alt="404"
        width={0}
        height={0}
        priority
        className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-[10%] md:h-auto md:w-full h-full w-auto max-h-screen pointer-events-none select-none"
      />
      <div
        className={cn(
          "relative w-[437px] max-w-[calc(100%-2rem)] overflow-clip rounded-[12px] p-6",
          "border border-[rgba(67,255,211,0.2)]",
          "bg-linear-to-b from-[rgba(39,39,39,0.07)] to-[rgba(40,40,40,0.14)]",
          "backdrop-blur-[47.5px]",
          "flex flex-col items-center gap-6"
        )}
      >
        <div className="flex flex-col items-center gap-1.5 text-center w-full">
          <h1 className="text-2xl font-medium text-white tracking-[-0.48px]">
            Wooops, this page is gone...
          </h1>
          <p className="text-base text-white/60 leading-6">
            It looks like you followed a link that no longer works. Try going
            back or return to the Dashboard.
          </p>
        </div>
        <Link
          href="/app"
          className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-white px-4 py-[7.5px] text-sm font-medium text-black transition-colors hover:bg-white/90"
        >
          Back to Dashboard
          <ArrowRight className="size-[13.25px]" />
        </Link>
      </div>
    </div>
  );
}
