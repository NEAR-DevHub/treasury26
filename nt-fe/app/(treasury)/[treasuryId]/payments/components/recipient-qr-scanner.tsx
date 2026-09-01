"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/icon";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/button";
import { extractAddressFromQrPayload } from "@/lib/qr-address";
import { cn } from "@/lib/utils";

type BarcodeDetectorLike = {
    detect: (
        source: ImageBitmapSource,
    ) => Promise<Array<{ rawValue?: string }>>;
};

function getBarcodeDetector(): BarcodeDetectorLike | null {
    if (typeof window === "undefined") return null;
    const Detector = (
        window as unknown as {
            BarcodeDetector?: new (options: {
                formats: string[];
            }) => BarcodeDetectorLike;
        }
    ).BarcodeDetector;
    if (!Detector) return null;
    try {
        return new Detector({ formats: ["qr_code"] });
    } catch {
        return null;
    }
}

interface RecipientQrScannerProps {
    onDetected: (address: string) => void;
    onBack: () => void;
}

export function RecipientQrScanner({
    onDetected,
    onBack,
}: RecipientQrScannerProps) {
    const t = useTranslations("paymentFormSection");
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const rafRef = useRef<number | null>(null);
    const detectedRef = useRef(false);
    const [error, setError] = useState<string | null>(null);
    const [isStarting, setIsStarting] = useState(true);

    useEffect(() => {
        let cancelled = false;

        async function start() {
            setIsStarting(true);
            setError(null);
            detectedRef.current = false;

            if (!navigator.mediaDevices?.getUserMedia) {
                setError(t("qrCameraUnsupported"));
                setIsStarting(false);
                return;
            }

            try {
                const stream = await navigator.mediaDevices.getUserMedia({
                    audio: false,
                    video: {
                        facingMode: { ideal: "environment" },
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                    },
                });
                if (cancelled) {
                    stream.getTracks().forEach((track) => track.stop());
                    return;
                }

                streamRef.current = stream;
                const video = videoRef.current;
                if (!video) return;
                video.srcObject = stream;
                await video.play();
                setIsStarting(false);

                const detector = getBarcodeDetector();
                const canvas = canvasRef.current;
                const ctx = canvas?.getContext("2d", {
                    willReadFrequently: true,
                });

                let jsQR:
                    | ((
                          data: Uint8ClampedArray,
                          width: number,
                          height: number,
                      ) => { data: string } | null)
                    | null = null;

                if (!detector) {
                    const mod = await import("jsqr");
                    jsQR = mod.default;
                }

                const tick = async () => {
                    if (cancelled || detectedRef.current) return;
                    const el = videoRef.current;
                    if (
                        !el ||
                        el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
                    ) {
                        rafRef.current = requestAnimationFrame(() => {
                            void tick();
                        });
                        return;
                    }

                    try {
                        if (detector) {
                            const codes = await detector.detect(el);
                            const value = codes[0]?.rawValue;
                            if (value) {
                                const address =
                                    extractAddressFromQrPayload(value);
                                if (address) {
                                    detectedRef.current = true;
                                    onDetected(address);
                                    return;
                                }
                            }
                        } else if (canvas && ctx && jsQR) {
                            const w = el.videoWidth;
                            const h = el.videoHeight;
                            if (w > 0 && h > 0) {
                                canvas.width = w;
                                canvas.height = h;
                                ctx.drawImage(el, 0, 0, w, h);
                                const image = ctx.getImageData(0, 0, w, h);
                                const code = jsQR(
                                    image.data,
                                    image.width,
                                    image.height,
                                );
                                if (code?.data) {
                                    const address = extractAddressFromQrPayload(
                                        code.data,
                                    );
                                    if (address) {
                                        detectedRef.current = true;
                                        onDetected(address);
                                        return;
                                    }
                                }
                            }
                        }
                    } catch {
                        /* frame decode errors are transient */
                    }

                    rafRef.current = requestAnimationFrame(() => {
                        void tick();
                    });
                };

                rafRef.current = requestAnimationFrame(() => {
                    void tick();
                });
            } catch {
                if (!cancelled) {
                    setError(t("qrCameraPermissionDenied"));
                    setIsStarting(false);
                }
            }
        }

        void start();

        return () => {
            cancelled = true;
            if (rafRef.current != null) {
                cancelAnimationFrame(rafRef.current);
            }
            streamRef.current?.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        };
    }, [onDetected, t]);

    return (
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 sm:mt-0">
            <p className="text-sm font-medium leading-normal text-general-secondary-foreground">
                {t("qrScanHint")}
            </p>

            <div className="relative min-h-0 flex-1 overflow-hidden rounded-3xl bg-muted">
                <video
                    ref={videoRef}
                    playsInline
                    muted
                    autoPlay
                    className={cn(
                        "size-full object-cover",
                        (error || isStarting) && "opacity-0",
                    )}
                />
                <canvas ref={canvasRef} className="hidden" />

                {!error ? (
                    <div
                        aria-hidden
                        className="pointer-events-none absolute inset-0 flex items-center justify-center"
                    >
                        <div className="relative size-48">
                            <span className="absolute top-0 left-0 size-8 rounded-tl-lg border-t-2 border-l-2 border-white" />
                            <span className="absolute top-0 right-0 size-8 rounded-tr-lg border-t-2 border-r-2 border-white" />
                            <span className="absolute bottom-0 left-0 size-8 rounded-bl-lg border-b-2 border-l-2 border-white" />
                            <span className="absolute right-0 bottom-0 size-8 rounded-br-lg border-r-2 border-b-2 border-white" />
                        </div>
                    </div>
                ) : null}

                {isStarting && !error ? (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                        {t("qrCameraStarting")}
                    </div>
                ) : null}

                {error ? (
                    <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm font-medium text-general-secondary-foreground">
                        {error}
                    </div>
                ) : null}
            </div>

            <Button
                type="button"
                variant="secondary"
                className="h-11 w-full shrink-0 gap-2 rounded-2xl text-sm font-bold text-general-secondary-foreground"
                onClick={onBack}
            >
                <Icon icon={ArrowLeft01Icon} className="size-4" />
                {t("qrBackToRecipientList")}
            </Button>
        </div>
    );
}
