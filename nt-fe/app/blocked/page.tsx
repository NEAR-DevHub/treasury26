export default function BlockedPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-black p-6">
      <div className="flex w-[437px] max-w-[calc(100%-2rem)] flex-col items-center gap-6 rounded-[12px] border border-[rgba(67,255,211,0.2)] bg-linear-to-b from-[rgba(39,39,39,0.07)] to-[rgba(40,40,40,0.14)] p-6 backdrop-blur-[47.5px]">
        <div className="flex flex-col items-center gap-1.5 text-center w-full">
          <h1 className="text-2xl font-medium text-white tracking-[-0.48px]">
            Access Restricted
          </h1>
          <p className="text-base text-white/60 leading-6">
            NEAR Treasury is not available in your region due to regulatory
            restrictions. If you believe this is an error, please contact
            support.
          </p>
        </div>
      </div>
    </div>
  );
}
