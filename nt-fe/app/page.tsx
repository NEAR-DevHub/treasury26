"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/button";

export default function Home() {
  const [message, setMessage] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const fetchMessage = async () => {
      try {
        const response = await fetch("http://127.0.0.1:3002");
        if (!response.ok) {
          throw new Error("Failed to fetch");
        }
        const text = await response.text();
        setMessage(text);
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
      } finally {
        setLoading(false);
      }
    };

    fetchMessage();
  }, []);


  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex min-h-screen w-full max-w-3xl flex-col items-center justify-center gap-8 py-32 px-16 bg-white dark:bg-black">
        <h1 className="text-4xl font-bold text-black dark:text-zinc-50">
          Next.js + Axum Backend
        </h1>

        <div className="flex flex-col items-center gap-4 p-8 rounded-lg border">
          <h2 className="text-xl font-semibold text-zinc-700 dark:text-zinc-300">
            Message from Backend:
          </h2>

          {loading && (
            <p className="text-lg text-zinc-500 dark:text-zinc-400">Loading...</p>
          )}

          {error && (
            <p className="text-lg text-red-600 dark:text-red-400">
              Error: {error}
            </p>
          )}

          {message && !loading && !error && (
            <p className="text-2xl font-bold text-green-600 dark:text-green-400">
              {message}
            </p>
          )}
        </div>

        <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-md text-center">
          This page fetches data from the Axum backend running on http://127.0.0.1:3002
        </p>

        <Link href="/app">
          <Button size="lg" className="mt-8">
            Go to App
          </Button>
        </Link>
      </main>
    </div>
  );
}
